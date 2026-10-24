//! The Nook's media panel, fed by Windows' own media session.
//!
//! `GlobalSystemMediaTransportControlsSessionManager` is the same API the
//! volume flyout uses: whichever app Windows itself considers to be playing is
//! the session shown here, so no player is special-cased and nothing is scraped.
//!
//! One worker thread owns the WinRT objects and polls them; every *command*
//! (transport, seek, shuffle, repeat) is sent to that same thread, because the
//! session object is only touched from the apartment it was created in.
//!
//! Three things keep the panel honest:
//!
//! * the position comes from Windows' own `LastUpdatedTime`, so a paused track
//!   stops and a resumed one continues from the right place even when the
//!   player publishes its timeline only once;
//! * artwork is read once per track, retried while it is still missing, and
//!   sent only on request or on change - never on every poll;
//! * a seek is verified against the session it was sent to, with the same
//!   pause/seek/resume fallback the WPF original needed for players that
//!   ignore a direct position change.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use windows::Foundation::DateTime;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};

pub const MEDIA_EVENT: &str = "media-state";
/// Emitted once per seek, whatever the outcome, so the bar can stop holding a
/// preview that the player never accepted.
pub const SEEK_EVENT: &str = "media-seek";

/// Fast enough that the bar moves with the player, slow enough not to be rude.
const POLL_OPEN: Duration = Duration::from_millis(500);
/// While the panel is closed only the collapsed indicator needs the state; a
/// sleeping machine is not polled any faster than it has to be.
const POLL_CLOSED: Duration = Duration::from_millis(1500);
/// Album art above this is refused rather than copied into a data URL; Windows
/// thumbnails are normally tens of kilobytes.
const MAX_ART_BYTES: u64 = 4 * 1024 * 1024;
/// Players publish the cover a moment after the metadata; retry a handful of
/// polls before accepting that this track has none.
const ART_RETRIES: u32 = 12;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPayload {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub has_timeline: bool,
    /// Omitted when the artwork has not changed since the last emit, so a
    /// 400 KB data URL is not streamed four times a second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub can_previous: bool,
    pub can_next: bool,
    pub can_toggle: bool,
    pub can_seek: bool,
    pub shuffle: bool,
    pub shuffle_supported: bool,
    pub repeat: String,
    pub repeat_supported: bool,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekOutcome {
    pub applied: bool,
    pub position_ms: u64,
}

pub enum Action {
    Previous,
    Toggle,
    Next,
    Seek(u64),
    SetShuffle(bool),
    SetRepeat(bool),
    /// "The panel just opened": publish everything, artwork included.
    Snapshot,
    /// Position polling is only useful while the bar is on screen.
    SetPolling(bool),
}

pub struct Control(Sender<Action>);

impl Control {
    pub fn send(&self, action: Action) {
        let _ = self.0.send(action);
    }
}

// ---------------------------------------------------------------------------
// Small, testable arithmetic
// ---------------------------------------------------------------------------

/// Windows hands timeline values in 100 ns ticks since 1601.
fn ticks_to_ms(ticks: i64) -> u64 {
    if ticks <= 0 {
        0
    } else {
        (ticks as u64) / 10_000
    }
}

fn now_filetime_ticks() -> i64 {
    const EPOCH_DIFF_SECS: u64 = 11_644_473_600;
    let since_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    ((since_unix.as_secs() + EPOCH_DIFF_SECS) * 10_000_000) as i64
        + i64::from(since_unix.subsec_nanos() / 100)
}

/// A player publishes `position` as of `updated`; while it is playing the
/// displayed position is that value plus real elapsed time. A stale or absurd
/// timestamp (sleep, clock change) contributes nothing rather than jumping the
/// bar to the end of the track.
fn advance_position(position_ms: u64, updated: DateTime, playing: bool, now_ticks: i64) -> u64 {
    if !playing {
        return position_ms;
    }
    let elapsed_ticks = now_ticks.saturating_sub(updated.UniversalTime);
    if elapsed_ticks <= 0 {
        return position_ms;
    }
    let elapsed_ms = ticks_to_ms(elapsed_ticks);
    // Anything a day old or more is not a playback offset any more.
    if elapsed_ms >= 86_400_000 {
        return position_ms;
    }
    position_ms.saturating_add(elapsed_ms)
}

fn clamp_position(position_ms: u64, duration_ms: u64) -> u64 {
    if duration_ms > 0 {
        position_ms.min(duration_ms)
    } else {
        position_ms
    }
}

fn repeat_label(mode: MediaPlaybackAutoRepeatMode) -> &'static str {
    match mode {
        MediaPlaybackAutoRepeatMode::List => "list",
        MediaPlaybackAutoRepeatMode::Track => "track",
        _ => "none",
    }
}

/// The cover rides along only when it is new (or the panel asked for a full
/// snapshot); a position poll must not resend a 50 KB data URL.
fn include_art(force: bool, generation: u64, last_sent: u64) -> bool {
    force || generation != last_sent
}

/// Off -> all -> one -> off, the order every player's repeat button uses.
fn next_repeat(mode: &str) -> MediaPlaybackAutoRepeatMode {
    match mode {
        "none" => MediaPlaybackAutoRepeatMode::List,
        "list" => MediaPlaybackAutoRepeatMode::Track,
        _ => MediaPlaybackAutoRepeatMode::None,
    }
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

fn track_key(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> (String, String, String) {
    let text = |value: windows::core::Result<windows::core::HSTRING>| {
        value.map(|v| v.to_string_lossy()).unwrap_or_default()
    };
    (
        text(props.Title()),
        text(props.Artist()),
        text(props.AlbumTitle()),
    )
}

/// Reads the session's album art through a `DataReader`. Windows hands back a
/// random-access stream; anything that fails (no art, a revoked stream, an
/// oversized image) is simply "no cover" - the panel keeps its gradient.
fn album_art(reference: &IRandomAccessStreamReference) -> Option<String> {
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ART_BYTES {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = stream
        .ContentType()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|_| "image/png".into());
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Small standard-alphabet encoder, enough for a data URL.
fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let value = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(char::from(TABLE[(value >> 18) as usize & 63]));
        out.push(char::from(TABLE[(value >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(TABLE[(value >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(TABLE[value as usize & 63])
        } else {
            '='
        });
    }
    out
}

/// Which session to show: the one Windows picked, or - when a player has left
/// its session behind but another one exists - the first that does.
fn pick_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    if let Ok(session) = manager.GetCurrentSession() {
        return Some(session);
    }
    let sessions = manager.GetSessions().ok()?;
    let size = sessions.Size().ok()?;
    (0..size).find_map(|index| sessions.GetAt(index).ok())
}

/// Everything one poll reads from the session, before artwork is attached.
struct Reading {
    payload: MediaPayload,
    art_reference: Option<IRandomAccessStreamReference>,
}

fn read_session(
    session: &GlobalSystemMediaTransportControlsSession,
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
    now: i64,
) -> Reading {
    let (title, artist, album) = track_key(props);

    // One PlaybackInfo call answers the status, the three transport buttons,
    // shuffle, repeat and whether the bar may be dragged at all.
    let playback = session.GetPlaybackInfo().ok();
    let playing = playback
        .as_ref()
        .and_then(|info| info.PlaybackStatus().ok())
        .is_some_and(|status| {
            status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
        });

    let shuffle_reference = playback
        .as_ref()
        .and_then(|info| info.IsShuffleActive().ok());
    let shuffle_value = shuffle_reference
        .as_ref()
        .and_then(|value| value.Value().ok());
    let shuffle = shuffle_value.unwrap_or(false);
    let repeat_reference = playback
        .as_ref()
        .and_then(|info| info.AutoRepeatMode().ok());
    let repeat_value = repeat_reference
        .as_ref()
        .and_then(|value| value.Value().ok());
    let repeat_mode = repeat_value.map(repeat_label).unwrap_or("none");

    let controls = playback.as_ref().and_then(|info| info.Controls().ok());
    // A value alone is not support: Windows hands every source a default, and
    // a source that has no handler for the mode says so on its controls. Show
    // the button only when both agree, so a player that ignores shuffle does
    // not get a button that pretends otherwise.
    let mode_enabled = |shuffle_mode: bool| {
        controls
            .as_ref()
            .map(|controls| {
                if shuffle_mode {
                    controls.IsShuffleEnabled().unwrap_or(false)
                } else {
                    controls.IsRepeatEnabled().unwrap_or(false)
                }
            })
            .unwrap_or(true)
    };
    let shuffle_supported = shuffle_value.is_some() && mode_enabled(true);
    let repeat_supported = repeat_value.is_some() && mode_enabled(false);

    let (can_previous, can_next, can_toggle, can_position) = controls
        .as_ref()
        .map(|controls| {
            (
                controls.IsPreviousEnabled().unwrap_or(true),
                controls.IsNextEnabled().unwrap_or(true),
                controls.IsPlayPauseToggleEnabled().unwrap_or(true),
                controls.IsPlaybackPositionEnabled().unwrap_or(false),
            )
        })
        .unwrap_or((true, true, true, false));

    let (mut position_ms, mut duration_ms, mut has_timeline) = (0u64, 0u64, false);
    if let Ok(timeline) = session.GetTimelineProperties() {
        let start = timeline.StartTime().map(|t| t.Duration).unwrap_or_default();
        let end = timeline.EndTime().map(|t| t.Duration).unwrap_or_default();
        let position = timeline.Position().map(|t| t.Duration).unwrap_or_default();
        if end > start {
            duration_ms = ticks_to_ms(end - start);
            let base = ticks_to_ms(position.saturating_sub(start));
            position_ms = advance_position(
                base,
                timeline.LastUpdatedTime().unwrap_or_default(),
                playing,
                now,
            );
            position_ms = clamp_position(position_ms, duration_ms);
            has_timeline = true;
        }
    }

    Reading {
        payload: MediaPayload {
            title,
            artist,
            album,
            playing,
            position_ms,
            duration_ms,
            has_timeline,
            thumbnail: None,
            can_previous,
            can_next,
            can_toggle,
            can_seek: can_position && has_timeline,
            shuffle,
            shuffle_supported,
            repeat: repeat_mode.to_string(),
            repeat_supported,
            source: session
                .SourceAppUserModelId()
                .map(|value| value.to_string_lossy())
                .unwrap_or_default(),
        },
        art_reference: props.Thumbnail().ok(),
    }
}

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

fn playback_status(session: &GlobalSystemMediaTransportControlsSession) -> bool {
    session
        .GetPlaybackInfo()
        .ok()
        .and_then(|info| info.PlaybackStatus().ok())
        .is_some_and(|status| {
            status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
        })
}

/// Reads the live position back from a specific session - the one the seek was
/// sent to, not whichever session is current by now.
fn read_position(session: &GlobalSystemMediaTransportControlsSession, now: i64) -> Option<u64> {
    let timeline = session.GetTimelineProperties().ok()?;
    let start = timeline.StartTime().ok()?.Duration;
    let end = timeline.EndTime().ok()?.Duration;
    if end <= start {
        return None;
    }
    let position = timeline.Position().ok()?.Duration;
    let playing = playback_status(session);
    let advanced = advance_position(
        ticks_to_ms(position.saturating_sub(start)),
        timeline.LastUpdatedTime().unwrap_or_default(),
        playing,
        now,
    );
    Some(clamp_position(advanced, ticks_to_ms(end - start)))
}

fn send_seek(session: &GlobalSystemMediaTransportControlsSession, target_ms: u64) -> bool {
    let Ok(timeline) = session.GetTimelineProperties() else {
        return false;
    };
    let Ok(start) = timeline.StartTime() else {
        return false;
    };
    let start = start.Duration;
    let target = start.saturating_add((target_ms as i64).saturating_mul(10_000));
    session
        .TryChangePlaybackPositionAsync(target)
        .and_then(|operation| operation.get())
        .unwrap_or(false)
}

fn settled(session: &GlobalSystemMediaTransportControlsSession, target_ms: u64) -> bool {
    (0..3).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        read_position(session, now_filetime_ticks())
            .is_some_and(|position| position.abs_diff(target_ms) < 1000)
    })
}

/// Direct seeks work on most players; a few only accept a position while
/// paused. The fallback resumes only after pausing the session itself, so a
/// track the user had paused is never started behind their back.
fn perform_seek(
    session: &GlobalSystemMediaTransportControlsSession,
    target_ms: u64,
) -> SeekOutcome {
    let duration = session
        .GetTimelineProperties()
        .ok()
        .and_then(|timeline| {
            let start = timeline.StartTime().ok()?.Duration;
            let end = timeline.EndTime().ok()?.Duration;
            (end > start).then(|| ticks_to_ms(end - start))
        })
        .unwrap_or(0);
    let target = clamp_position(target_ms, duration);

    if send_seek(session, target) && settled(session, target) {
        return SeekOutcome {
            applied: true,
            position_ms: read_position(session, now_filetime_ticks()).unwrap_or(target),
        };
    }

    let was_playing = playback_status(session);
    let mut paused_by_us = false;
    if was_playing {
        paused_by_us = session
            .TryPauseAsync()
            .and_then(|operation| operation.get())
            .unwrap_or(false);
        if paused_by_us {
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    let accepted = send_seek(session, target);
    std::thread::sleep(Duration::from_millis(150));
    if paused_by_us {
        let _ = session.TryPlayAsync().and_then(|operation| operation.get());
    }

    let applied = accepted && settled(session, target);
    SeekOutcome {
        applied,
        position_ms: read_position(session, now_filetime_ticks()).unwrap_or(target),
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

fn publish(app: &AppHandle, payload: Option<MediaPayload>) {
    if let Err(error) = app.emit(MEDIA_EVENT, payload) {
        eprintln!("emitting media state failed: {error}");
    }
}

/// What the panel last saw, so an unchanged poll is not re-sent. The artwork
/// has its own generation: it appears once per track, not once per poll.
#[derive(Default)]
struct Emitted {
    key: Option<(String, String, String, String)>,
    playing: bool,
    position_sec: u64,
    duration_ms: u64,
    capabilities: (bool, bool, bool, bool, bool, bool, String),
    art_generation: u64,
}

impl Emitted {
    fn matches(&self, payload: &MediaPayload, generation: u64) -> bool {
        self.key.as_ref().is_some_and(|key| {
            key.0 == payload.title
                && key.1 == payload.artist
                && key.2 == payload.album
                && key.3 == payload.source
        }) && self.playing == payload.playing
            && self.position_sec == payload.position_ms / 1000
            && self.duration_ms == payload.duration_ms
            && self.capabilities
                == (
                    payload.can_previous,
                    payload.can_next,
                    payload.can_toggle,
                    payload.can_seek,
                    payload.shuffle,
                    payload.repeat_supported,
                    payload.repeat.clone(),
                )
            && self.art_generation == generation
    }

    fn remember(&mut self, payload: &MediaPayload, generation: u64) {
        self.key = Some((
            payload.title.clone(),
            payload.artist.clone(),
            payload.album.clone(),
            payload.source.clone(),
        ));
        self.playing = payload.playing;
        self.position_sec = payload.position_ms / 1000;
        self.duration_ms = payload.duration_ms;
        self.capabilities = (
            payload.can_previous,
            payload.can_next,
            payload.can_toggle,
            payload.can_seek,
            payload.shuffle,
            payload.repeat_supported,
            payload.repeat.clone(),
        );
        self.art_generation = generation;
    }
}

/// The cover for the track that is playing now, kept between polls. `generation`
/// increments whenever new bytes arrive so the emitter knows to include them.
#[derive(Default)]
struct Artwork {
    key: Option<(String, String, String)>,
    data: Option<String>,
    generation: u64,
    attempts: u32,
}

impl Artwork {
    /// Returns whether the cached cover belongs to this track, reading it if
    /// this is a new track or the previous read came back empty too early.
    fn resolve(
        &mut self,
        key: (String, String, String),
        reference: Option<&IRandomAccessStreamReference>,
        force: bool,
    ) -> bool {
        let same_track = self.key.as_ref() == Some(&key);
        if same_track && self.data.is_some() && !force {
            return true;
        }
        let retry = !same_track || (self.data.is_none() && self.attempts < ART_RETRIES);
        if !same_track {
            self.key = Some(key);
            self.data = None;
            self.attempts = 0;
        }
        if retry || force {
            self.attempts = self.attempts.saturating_add(1);
            if let Some(art) = reference.and_then(album_art) {
                self.data = Some(art);
                self.generation = self.generation.wrapping_add(1);
                return true;
            }
        }
        same_track
    }

    fn forget(&mut self) {
        if self.key.take().is_some() || self.data.take().is_some() {
            self.generation = self.generation.wrapping_add(1);
        }
        self.attempts = 0;
    }
}

fn watch(app: AppHandle, commands: Receiver<Action>) {
    if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        eprintln!("media WinRT initialization failed: {error}");
        return;
    }
    let Ok(manager) =
        GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get())
    else {
        eprintln!("no media session manager on this system");
        unsafe { RoUninitialize() };
        return;
    };

    let mut art = Artwork::default();
    let mut emitted = Emitted::default();
    let mut polling = false;
    let mut next_poll = Instant::now();
    // Set after a command so the next read reflects the press immediately.
    let mut force_poll = true;
    let mut force_art = false;

    loop {
        // Wait up to the next poll, but wake for a command straight away.
        let wait = next_poll.saturating_duration_since(Instant::now());
        match commands.recv_timeout(wait) {
            Ok(Action::Previous) => {
                if let Some(session) = pick_session(&manager) {
                    let _ = session.TrySkipPreviousAsync().and_then(|op| op.get());
                }
                force_poll = true;
            }
            Ok(Action::Next) => {
                if let Some(session) = pick_session(&manager) {
                    let _ = session.TrySkipNextAsync().and_then(|op| op.get());
                }
                force_poll = true;
            }
            Ok(Action::Toggle) => {
                if let Some(session) = pick_session(&manager) {
                    let _ = session.TryTogglePlayPauseAsync().and_then(|op| op.get());
                }
                force_poll = true;
            }
            Ok(Action::Seek(position_ms)) => {
                if let Some(session) = pick_session(&manager) {
                    let outcome = perform_seek(&session, position_ms);
                    let _ = app.emit(SEEK_EVENT, outcome);
                }
                force_poll = true;
            }
            Ok(Action::SetShuffle(active)) => {
                if let Some(session) = pick_session(&manager) {
                    let _ = session
                        .TryChangeShuffleActiveAsync(active)
                        .and_then(|op| op.get());
                }
                force_poll = true;
            }
            Ok(Action::SetRepeat(advance)) => {
                if let Some(session) = pick_session(&manager) {
                    let current = session
                        .GetPlaybackInfo()
                        .ok()
                        .and_then(|info| info.AutoRepeatMode().ok())
                        .and_then(|value| value.Value().ok())
                        .map(repeat_label)
                        .unwrap_or("none");
                    let target = if advance {
                        next_repeat(current)
                    } else {
                        MediaPlaybackAutoRepeatMode::None
                    };
                    let _ = session
                        .TryChangeAutoRepeatModeAsync(target)
                        .and_then(|op| op.get());
                }
                force_poll = true;
            }
            Ok(Action::Snapshot) => {
                force_poll = true;
                force_art = true;
            }
            Ok(Action::SetPolling(active)) => {
                polling = active;
                force_poll = true;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }

        if !force_poll && Instant::now() < next_poll {
            continue;
        }

        let now = now_filetime_ticks();
        let session = pick_session(&manager);
        let props = session.as_ref().and_then(|session| {
            session
                .TryGetMediaPropertiesAsync()
                .ok()
                .and_then(|operation| operation.get().ok())
        });

        match (session.as_ref(), props.as_ref()) {
            (Some(session), Some(props)) => {
                let mut reading = read_session(session, props, now);
                let key = (
                    reading.payload.title.clone(),
                    reading.payload.artist.clone(),
                    reading.payload.album.clone(),
                );
                let has_art = art.resolve(key, reading.art_reference.as_ref(), force_art);
                // A track with art but not yet delivered must not let the panel
                // forget the previous cover and then never update it.
                if has_art || art.data.is_some() {
                    reading.payload.thumbnail = art.data.clone();
                }
                let generation = art.generation;
                // The cover belongs to the track, not to the second: send it
                // once when it arrives (or when the panel asks), and let the
                // webview keep it across the position polls in between.
                if !include_art(force_art, generation, emitted.art_generation) {
                    reading.payload.thumbnail = None;
                }
                if force_art || !emitted.matches(&reading.payload, generation) {
                    emitted.remember(&reading.payload, generation);
                    publish(&app, Some(reading.payload));
                }
            }
            // No session at all: that is a fact worth reporting once.
            (None, _) => {
                art.forget();
                if emitted.key.take().is_some() {
                    emitted = Emitted::default();
                    publish(&app, None);
                }
            }
            // A session exists but properties are momentarily unavailable. Keep
            // the last state instead of flashing "no media" at the user.
            (Some(_), None) => {}
        }

        force_poll = false;
        force_art = false;
        next_poll = Instant::now() + if polling { POLL_OPEN } else { POLL_CLOSED };
    }

    unsafe { RoUninitialize() };
}

/// Starts the worker and returns the handle commands are sent through.
pub fn install(app: AppHandle) -> Control {
    let (tx, rx) = channel();
    let _ = std::thread::Builder::new()
        .name("media-session".into())
        .spawn(move || watch(app, rx));
    Control(tx)
}

fn parse_action(action: &str) -> Option<Action> {
    match action {
        "previous" => Some(Action::Previous),
        "toggle" => Some(Action::Toggle),
        "next" => Some(Action::Next),
        _ => None,
    }
}

/// The webview's transport controls. Unknown actions are rejected so the
/// command surface stays exactly as wide as the panel's buttons.
pub fn command(control: &Control, action: &str) -> Result<(), String> {
    match parse_action(action) {
        Some(action) => {
            control.send(action);
            Ok(())
        }
        None => Err(format!("unknown media action: {action}")),
    }
}

pub fn seek(control: &Control, position_ms: u64) -> Result<(), String> {
    if position_ms > 24 * 60 * 60 * 1000 {
        return Err("seek target is out of range".into());
    }
    control.send(Action::Seek(position_ms));
    Ok(())
}

pub fn shuffle(control: &Control, active: bool) {
    control.send(Action::SetShuffle(active));
}

pub fn repeat(control: &Control, advance: bool) {
    control.send(Action::SetRepeat(advance));
}

pub fn snapshot(control: &Control) {
    control.send(Action::Snapshot);
}

pub fn set_polling(control: &Control, active: bool) {
    control.send(Action::SetPolling(active));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads_and_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0x00, 0xfe]), "/wD+");
    }

    #[test]
    fn position_advances_only_while_playing() {
        let now = now_filetime_ticks();
        let two_seconds_ago = DateTime {
            UniversalTime: now - 20_000_000,
        };
        assert_eq!(advance_position(30_000, two_seconds_ago, true, now), 32_000);
        assert_eq!(
            advance_position(30_000, two_seconds_ago, false, now),
            30_000
        );

        // A publication in the future, or a clock change, is not a jump.
        let in_the_future = DateTime {
            UniversalTime: now + 5_000_000,
        };
        assert_eq!(advance_position(30_000, in_the_future, true, now), 30_000);

        // Coming back from sleep must not land the bar past the track.
        let yesterday = DateTime {
            UniversalTime: now - 864_000_000_000,
        };
        assert_eq!(advance_position(30_000, yesterday, true, now), 30_000);
    }

    #[test]
    fn position_is_clamped_to_the_reported_duration() {
        assert_eq!(clamp_position(90_000, 60_000), 60_000);
        assert_eq!(clamp_position(30_000, 60_000), 30_000);
        // A live stream has no known end; leave the position alone.
        assert_eq!(clamp_position(30_000, 0), 30_000);
    }

    #[test]
    fn repeat_cycles_off_list_track() {
        assert_eq!(repeat_label(MediaPlaybackAutoRepeatMode::None), "none");
        assert_eq!(repeat_label(MediaPlaybackAutoRepeatMode::List), "list");
        assert_eq!(repeat_label(MediaPlaybackAutoRepeatMode::Track), "track");
        assert_eq!(next_repeat("none"), MediaPlaybackAutoRepeatMode::List);
        assert_eq!(next_repeat("list"), MediaPlaybackAutoRepeatMode::Track);
        assert_eq!(next_repeat("track"), MediaPlaybackAutoRepeatMode::None);
    }

    #[test]
    fn ticks_convert_to_milliseconds_and_never_go_negative() {
        assert_eq!(ticks_to_ms(10_000), 1);
        assert_eq!(ticks_to_ms(0), 0);
        assert_eq!(ticks_to_ms(-5), 0);
    }

    #[test]
    fn an_unchanged_poll_is_not_re_emitted() {
        let payload = MediaPayload {
            title: "A".into(),
            artist: "B".into(),
            album: "C".into(),
            playing: true,
            position_ms: 1_200,
            duration_ms: 180_000,
            has_timeline: true,
            thumbnail: None,
            can_previous: true,
            can_next: true,
            can_toggle: true,
            can_seek: true,
            shuffle: false,
            shuffle_supported: true,
            repeat: "none".into(),
            repeat_supported: true,
            source: "Spotify.exe".into(),
        };
        let mut emitted = Emitted::default();
        assert!(!emitted.matches(&payload, 1));
        emitted.remember(&payload, 1);
        assert!(emitted.matches(&payload, 1));

        // A new cover is worth a new emit even on the same second.
        assert!(!emitted.matches(&payload, 2));
        // So is a seek within the same second.
        let mut moved = payload.clone();
        moved.position_ms = 2_200;
        emitted.remember(&payload, 1);
        assert!(!emitted.matches(&moved, 1));
    }

    #[test]
    fn a_cover_is_sent_when_it_is_new_not_on_every_poll() {
        assert!(include_art(false, 3, 2));
        assert!(include_art(true, 3, 3));
        assert!(!include_art(false, 3, 3));
        // The first poll that finds no art sends no art either.
        assert!(!include_art(false, 0, 0));
    }

    #[test]
    #[ignore = "manual passive Windows media-session probe (no playback started)"]
    fn media_windows_probe() {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).unwrap() };
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .expect("media session manager");
        match pick_session(&manager) {
            Some(session) => {
                let props = session
                    .TryGetMediaPropertiesAsync()
                    .and_then(|op| op.get())
                    .expect("media properties");
                let reading = read_session(&session, &props, now_filetime_ticks());
                let thumb = reading.art_reference.as_ref().and_then(album_art);
                println!(
                    "title={:?} artist={:?} playing={} {}/{}ms art={} seek={} shuffle={}/{} repeat={}/{} source={}",
                    reading.payload.title,
                    reading.payload.artist,
                    reading.payload.playing,
                    reading.payload.position_ms,
                    reading.payload.duration_ms,
                    thumb.as_ref().map(|art| art.len()).unwrap_or(0),
                    reading.payload.can_seek,
                    reading.payload.shuffle,
                    reading.payload.shuffle_supported,
                    reading.payload.repeat,
                    reading.payload.repeat_supported,
                    reading.payload.source
                );
            }
            None => println!("no current session"),
        }
        unsafe { RoUninitialize() };
    }

    #[test]
    #[ignore = "manual Windows probe: seeks the current player 5s forward"]
    fn media_seek_probe() {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).unwrap() };
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .expect("media session manager");
        let session = pick_session(&manager).expect("media session");
        let before = read_position(&session, now_filetime_ticks()).expect("timeline");
        let target = before.saturating_add(5_000);
        let outcome = perform_seek(&session, target);
        let after = read_position(&session, now_filetime_ticks()).expect("timeline");
        println!(
            "before={before} target={target} applied={} reported={} after={after}",
            outcome.applied, outcome.position_ms
        );
        assert!(outcome.applied, "the player rejected the seek");
        assert!(
            after.abs_diff(target) < 1_500,
            "the position did not move to the target"
        );
        unsafe { RoUninitialize() };
    }
}
