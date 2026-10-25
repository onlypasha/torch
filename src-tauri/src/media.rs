//! The Nook's media panel, fed by Windows' own media session.
//!
//! `GlobalSystemMediaTransportControlsSessionManager` is the same API the
//! volume flyout uses: whichever app Windows itself considers to be playing is
//! the session shown here, so no player is special-cased and nothing is scraped.
//!
//! One worker thread owns the WinRT objects; every *command* (transport, seek,
//! shuffle, repeat) is sent to that same thread, because the session object is
//! only touched from the apartment it was created in.
//!
//! Like the WPF original, the worker subscribes to the session's own
//! `MediaPropertiesChanged`, `PlaybackInfoChanged` and
//! `TimelinePropertiesChanged` events and to the manager's
//! `CurrentSessionChanged`, so a play/pause, a seek or a track change wakes it
//! immediately instead of waiting for the next poll. The 500 ms poll stays as a
//! safety net for players that never raise those events.
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
use windows::Foundation::{DateTime, EventRegistrationToken, TypedEventHandler};
use windows::Media::Control::{
    CurrentSessionChangedEventArgs, GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus, MediaPropertiesChangedEventArgs,
    PlaybackInfoChangedEventArgs, TimelinePropertiesChangedEventArgs,
};
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::Interface;

pub const MEDIA_EVENT: &str = "media-state";
/// Emitted once per seek, whatever the outcome, so the bar can stop holding a
/// preview that the player never accepted.
pub const SEEK_EVENT: &str = "media-seek";

/// Fast enough that the bar moves with the player, slow enough not to be rude.
const POLL_OPEN: Duration = Duration::from_millis(500);
/// While the panel is closed only the collapsed indicator needs the state; a
/// sleeping machine is not polled any faster than it has to be.
const POLL_CLOSED: Duration = Duration::from_millis(1500);
/// Event-driven refreshes are collapsed: a player that publishes its timeline
/// on every progress tick must not turn into a hot polling loop.
const MIN_REFRESH_GAP: Duration = Duration::from_millis(120);
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
    /// Epoch millis when Windows last published this timeline. It is the
    /// publication's identity, not an age to add again: the position above is
    /// already projected to `sampled_at_ms`.
    pub timeline_updated_ms: Option<u64>,
    /// Playback rate (e.g. 1.0 = normal, 1.5 = 1.5x)
    pub playback_rate: f64,
    /// Epoch millis when `position_ms` was measured here. The webview advances
    /// the bar by the time the payload spent in flight, so a slow IPC hop or a
    /// busy frame cannot leave the words behind the voice.
    pub sampled_at_ms: u64,
}

/// Maximum time to latch missing timeline properties for the same song before
/// accepting that the track truly has no timeline (e.g. infinite live streams).
const TIMELINE_LATCH_TTL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, PartialEq)]
struct LatchedTimeline {
    key: (String, String, String, String),
    duration_ms: u64,
    last_position_ms: u64,
    can_seek: bool,
    has_timeline: bool,
    updated_at: Option<Instant>,
}

/// The track a seek was meant for. The webview sends the identity it computed
/// its target from, so a drag released just as the song changes is refused
/// instead of dropping the next song at the old one's position.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekOutcome {
    /// Echo of the request id, so an answer for an abandoned drag is ignored
    /// instead of moving the bar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<u64>,
    pub applied: bool,
    pub position_ms: u64,
    /// Epoch millis when `position_ms` was read.
    pub sampled_at_ms: u64,
    /// Why nothing was sent, when the worker refused the request outright.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
}

pub enum Action {
    Previous,
    Toggle,
    Next,
    Seek {
        token: Option<u64>,
        position_ms: u64,
        expected: Option<ExpectedTrack>,
    },
    SetShuffle(bool),
    SetRepeat(bool),
    /// "The panel just opened": publish everything, artwork included.
    Snapshot,
    /// Position polling is only useful while the bar is on screen.
    SetPolling(bool),
    /// A WinRT session/manager event says something changed right now.
    Refresh,
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
fn advance_position(position_ms: u64, updated: DateTime, playing: bool, rate: f64, now_ticks: i64) -> u64 {
    if !playing {
        return position_ms;
    }
    // If updated timestamp is zero or default (common in browsers/local players when backgrounded),
    // we cannot calculate elapsed time from it, return base position.
    if updated.UniversalTime <= 0 {
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
    let effective_rate = if rate > 0.0 && rate <= 16.0 { rate } else { 1.0 };
    let scaled_elapsed = ((elapsed_ms as f64) * effective_rate).round() as u64;
    position_ms.saturating_add(scaled_elapsed)
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
    sampled_at_ms: u64,
    latched: &mut LatchedTimeline,
    last_playing: Option<bool>,
) -> Reading {
    let (title, artist, album) = track_key(props);
    let source = session
        .SourceAppUserModelId()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    let key = (title.clone(), artist.clone(), album.clone(), source.clone());

    // One PlaybackInfo call answers the status, the three transport buttons,
    // shuffle, repeat and whether the bar may be dragged at all.
    let playback = session.GetPlaybackInfo().ok();
    let playing_res = playback
        .as_ref()
        .and_then(|info| info.PlaybackStatus().ok());
    let playing = match playing_res {
        Some(status) => status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
        None => last_playing.unwrap_or(false),
    };

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

    let playback_rate = playback
        .as_ref()
        .and_then(|info| info.PlaybackRate().ok())
        .and_then(|val| val.Value().ok())
        .unwrap_or(1.0);

    let (mut position_ms, mut duration_ms, mut has_timeline) = (0u64, 0u64, false);
    let mut timeline_updated_ms = None;
    if let Ok(timeline) = session.GetTimelineProperties() {
        let start = timeline.StartTime().map(|t| t.Duration).unwrap_or_default();
        let end = timeline.EndTime().map(|t| t.Duration).unwrap_or_default();
        let position = timeline.Position().map(|t| t.Duration).unwrap_or_default();
        if end > start {
            duration_ms = ticks_to_ms(end - start);
            let base = ticks_to_ms(position.saturating_sub(start));
            let updated = timeline.LastUpdatedTime().unwrap_or_default();
            if updated.UniversalTime > 0 {
                // Convert Windows FileTime ticks (since 1601) to Unix Epoch millis
                const EPOCH_DIFF_MS: u64 = 11_644_473_600_000;
                let updated_ms = ticks_to_ms(updated.UniversalTime);
                if updated_ms >= EPOCH_DIFF_MS {
                    timeline_updated_ms = Some(updated_ms - EPOCH_DIFF_MS);
                }
            }
            position_ms = advance_position(
                base,
                updated,
                playing,
                playback_rate,
                now,
            );
            position_ms = clamp_position(position_ms, duration_ms);
            has_timeline = true;
        }
    }

    if has_timeline && duration_ms > 0 {
        latched.key = key;
        latched.duration_ms = duration_ms;
        latched.last_position_ms = position_ms;
        latched.can_seek = can_position;
        latched.has_timeline = true;
        latched.updated_at = Some(Instant::now());
    } else if latched.key == key && latched.duration_ms > 0 {
        let within_ttl = latched
            .updated_at
            .is_some_and(|t| t.elapsed() < TIMELINE_LATCH_TTL);
        if within_ttl {
            let elapsed_since_latch = latched
                .updated_at
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0);
            duration_ms = latched.duration_ms;
            has_timeline = latched.has_timeline;
            position_ms = if playing {
                clamp_position(
                    latched.last_position_ms.saturating_add(elapsed_since_latch),
                    duration_ms,
                )
            } else {
                latched.last_position_ms
            };
        } else {
            // TTL expired: accept true zero duration / stream without timeline
            *latched = LatchedTimeline {
                key,
                ..Default::default()
            };
        }
    } else if latched.key != key {
        *latched = LatchedTimeline {
            key,
            ..Default::default()
        };
    }

    let final_can_seek = if has_timeline {
        can_position || (latched.duration_ms > 0 && latched.can_seek)
    } else {
        false
    };

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
            can_seek: final_can_seek,
            shuffle,
            shuffle_supported,
            repeat: repeat_mode.to_string(),
            repeat_supported,
            source,
            timeline_updated_ms,
            playback_rate,
            sampled_at_ms,
        },
        art_reference: props.Thumbnail().ok(),
    }
}

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

/// Epoch milliseconds, the unit the webview compares its own `Date.now()` to.
fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether the player still shows the track the seek was built for. Metadata
/// that cannot be read right now is treated as "unchanged": refusing every seek
/// on a slow read would be worse than sending one to a session that moved on.
fn session_matches(
    session: &GlobalSystemMediaTransportControlsSession,
    want: &ExpectedTrack,
) -> bool {
    let Ok(props) = session
        .TryGetMediaPropertiesAsync()
        .and_then(|operation| operation.get())
    else {
        return true;
    };
    let (title, artist, album) = track_key(&props);
    let source = session
        .SourceAppUserModelId()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    title == want.title && artist == want.artist && album == want.album && source == want.source
}

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
    let rate = session
        .GetPlaybackInfo()
        .ok()
        .and_then(|info| info.PlaybackRate().ok())
        .and_then(|val| val.Value().ok())
        .unwrap_or(1.0);
    let advanced = advance_position(
        ticks_to_ms(position.saturating_sub(start)),
        timeline.LastUpdatedTime().unwrap_or_default(),
        playing,
        rate,
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
///
/// Returns the player's own answer (applied, position). The worker attaches
/// the request token, so this stays a pure question about one session.
fn perform_seek(
    session: &GlobalSystemMediaTransportControlsSession,
    target_ms: u64,
) -> (bool, u64) {
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
        return (
            true,
            read_position(session, now_filetime_ticks()).unwrap_or(target),
        );
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
    (
        applied,
        read_position(session, now_filetime_ticks()).unwrap_or(target),
    )
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
    /// Source included: two players showing the same song must not share a
    /// cover, or switching apps would keep the wrong sleeve for a moment.
    key: Option<(String, String, String, String)>,
    data: Option<String>,
    generation: u64,
    attempts: u32,
}

impl Artwork {
    /// Returns whether the cached cover belongs to this track, reading it if
    /// this is a new track or the previous read came back empty too early.
    fn resolve(
        &mut self,
        key: (String, String, String, String),
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

/// The session currently watched for change events. WPF hooks the same three
/// events; without them the panel only learns about a pause or a seek on the
/// next poll, which is what made the bar and the lyrics lag behind the player.
#[derive(Default)]
struct SessionHook {
    session: Option<GlobalSystemMediaTransportControlsSession>,
    properties: Option<EventRegistrationToken>,
    playback: Option<EventRegistrationToken>,
    timeline: Option<EventRegistrationToken>,
}

impl SessionHook {
    fn attach(
        &mut self,
        session: Option<&GlobalSystemMediaTransportControlsSession>,
        wake: &Sender<Action>,
    ) {
        // `GetCurrentSession` hands out a fresh wrapper for the same COM object,
        // so compare the underlying pointers instead of the Rust values.
        let unchanged = match (&self.session, session) {
            (Some(current), Some(next)) => std::ptr::addr_eq(current.as_raw(), next.as_raw()),
            (None, None) => true,
            _ => false,
        };
        if unchanged {
            return;
        }

        self.detach();
        let Some(session) = session else { return };

        let handler = |wake: &Sender<Action>| {
            let wake = wake.clone();
            TypedEventHandler::<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs>::new(
                move |_, _| {
                    let _ = wake.send(Action::Refresh);
                    Ok(())
                },
            )
        };
        if let Ok(token) = session.MediaPropertiesChanged(&handler(wake)) {
            self.properties = Some(token);
        }

        let handler = |wake: &Sender<Action>| {
            let wake = wake.clone();
            TypedEventHandler::<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs>::new(
                move |_, _| {
                    let _ = wake.send(Action::Refresh);
                    Ok(())
                },
            )
        };
        if let Ok(token) = session.PlaybackInfoChanged(&handler(wake)) {
            self.playback = Some(token);
        }

        let handler = |wake: &Sender<Action>| {
            let wake = wake.clone();
            TypedEventHandler::<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs>::new(
                move |_, _| {
                    let _ = wake.send(Action::Refresh);
                    Ok(())
                },
            )
        };
        if let Ok(token) = session.TimelinePropertiesChanged(&handler(wake)) {
            self.timeline = Some(token);
        }

        self.session = Some(session.clone());
    }

    fn detach(&mut self) {
        if let Some(session) = self.session.take() {
            if let Some(token) = self.properties.take() {
                let _ = session.RemoveMediaPropertiesChanged(token);
            }
            if let Some(token) = self.playback.take() {
                let _ = session.RemovePlaybackInfoChanged(token);
            }
            if let Some(token) = self.timeline.take() {
                let _ = session.RemoveTimelinePropertiesChanged(token);
            }
        }
    }
}

fn watch(app: AppHandle, commands: Receiver<Action>, wake: Sender<Action>) {
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

    // A new current session (player opened, track switched apps) must be
    // re-hooked; the manager tells us immediately, like WPF's
    // `CurrentSessionChanged` handler.
    let manager_wake = wake.clone();
    let _manager_hook = manager.CurrentSessionChanged(&TypedEventHandler::<
        GlobalSystemMediaTransportControlsSessionManager,
        CurrentSessionChangedEventArgs,
    >::new(move |_, _| {
        let _ = manager_wake.send(Action::Refresh);
        Ok(())
    }));

    let mut art = Artwork::default();
    let mut emitted = Emitted::default();
    let mut latched = LatchedTimeline::default();
    let mut hook = SessionHook::default();
    let mut last_playing: Option<bool> = None;
    let mut polling = false;
    let mut next_poll = Instant::now();
    let mut last_poll = Instant::now() - MIN_REFRESH_GAP;
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
            Ok(Action::Seek {
                token,
                position_ms,
                expected,
            }) => {
                let requested_at_ms = now_epoch_ms();
                let outcome = match pick_session(&manager) {
                    Some(session)
                        if expected
                            .as_ref()
                            .map_or(true, |want| session_matches(&session, want)) =>
                    {
                        let (applied, position_ms) = perform_seek(&session, position_ms);
                        SeekOutcome {
                            token,
                            applied,
                            position_ms,
                            sampled_at_ms: now_epoch_ms(),
                            rejected: None,
                        }
                    }
                    // The song changed while the user was dragging. Report it
                    // rather than dropping the next track at the old position.
                    Some(session) => SeekOutcome {
                        token,
                        applied: false,
                        position_ms: read_position(&session, now_filetime_ticks()).unwrap_or(0),
                        sampled_at_ms: requested_at_ms,
                        rejected: Some("track-changed".into()),
                    },
                    None => SeekOutcome {
                        token,
                        applied: false,
                        position_ms: 0,
                        sampled_at_ms: requested_at_ms,
                        rejected: Some("no-session".into()),
                    },
                };
                let _ = app.emit(SEEK_EVENT, outcome);
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
                // Clear emitted cache on explicit snapshot request so fresh media state
                // and true current playback timeline are guaranteed to be published immediately.
                emitted = Emitted::default();
            }
            Ok(Action::SetPolling(active)) => {
                polling = active;
                force_poll = true;
            }
            Ok(Action::Refresh) => {
                // Collapse bursts of WinRT events: refresh now when the last read
                // is old enough, otherwise as soon as the gap allows.
                if last_poll.elapsed() >= MIN_REFRESH_GAP {
                    force_poll = true;
                } else {
                    next_poll = next_poll.min(last_poll + MIN_REFRESH_GAP);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }

        if !force_poll && Instant::now() < next_poll {
            continue;
        }

        let now = now_filetime_ticks();
        let sampled_at_ms = now_epoch_ms();
        let session = pick_session(&manager);
        // Hook before reading so the next change cannot slip between the read
        // and the subscription.
        hook.attach(session.as_ref(), &wake);
        let props = session.as_ref().and_then(|session| {
            session
                .TryGetMediaPropertiesAsync()
                .ok()
                .and_then(|operation| operation.get().ok())
        });

        match (session.as_ref(), props.as_ref()) {
            (Some(session), Some(props)) => {
                let mut reading = read_session(
                    session,
                    props,
                    now,
                    sampled_at_ms,
                    &mut latched,
                    last_playing,
                );
                last_playing = Some(reading.payload.playing);
                let key = (
                    reading.payload.title.clone(),
                    reading.payload.artist.clone(),
                    reading.payload.album.clone(),
                    reading.payload.source.clone(),
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
                latched = LatchedTimeline::default();
                last_playing = None;
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
        last_poll = Instant::now();
        next_poll = last_poll + if polling { POLL_OPEN } else { POLL_CLOSED };
    }

    hook.detach();
    unsafe { RoUninitialize() };
}

/// Starts the worker and returns the handle commands are sent through.
pub fn install(app: AppHandle) -> Control {
    let (tx, rx) = channel();
    let control = Control(tx.clone());
    let _ = std::thread::Builder::new()
        .name("media-session".into())
        .spawn(move || watch(app, rx, tx));
    control
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

pub fn seek(
    control: &Control,
    position_ms: u64,
    token: Option<u64>,
    expected: Option<ExpectedTrack>,
) -> Result<(), String> {
    if position_ms > 24 * 60 * 60 * 1000 {
        return Err("seek target is out of range".into());
    }
    control.send(Action::Seek {
        token,
        position_ms,
        expected,
    });
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
        assert_eq!(advance_position(30_000, two_seconds_ago, true, 1.0, now), 32_000);
        assert_eq!(advance_position(30_000, two_seconds_ago, true, 1.5, now), 33_000);
        assert_eq!(
            advance_position(30_000, two_seconds_ago, false, 1.0, now),
            30_000
        );

        // A publication in the future, or a clock change, is not a jump.
        let in_the_future = DateTime {
            UniversalTime: now + 5_000_000,
        };
        assert_eq!(advance_position(30_000, in_the_future, true, 1.0, now), 30_000);

        // Coming back from sleep must not land the bar past the track.
        let yesterday = DateTime {
            UniversalTime: now - 864_000_000_000,
        };
        assert_eq!(advance_position(30_000, yesterday, true, 1.0, now), 30_000);
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
            timeline_updated_ms: None,
            playback_rate: 1.0,
            sampled_at_ms: 1_700_000_000_000,
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
                let mut latched = LatchedTimeline::default();
                let reading = read_session(
                    &session,
                    &props,
                    now_filetime_ticks(),
                    now_epoch_ms(),
                    &mut latched,
                    None,
                );
                let thumb = reading.art_reference.as_ref().and_then(album_art);
                let sample_age_ms = now_epoch_ms().saturating_sub(reading.payload.sampled_at_ms);
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
                println!(
                    "sampled_at_ms={} sample_age_ms={sample_age_ms} timeline_updated_ms={:?} playback_rate={}",
                    reading.payload.sampled_at_ms,
                    reading.payload.timeline_updated_ms,
                    reading.payload.playback_rate
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
        let (applied, reported) = perform_seek(&session, target);
        let after = read_position(&session, now_filetime_ticks()).expect("timeline");
        println!(
            "before={before} target={target} applied={applied} reported={reported} after={after}"
        );
        assert!(applied, "the player rejected the seek");
        assert!(
            after.abs_diff(target) < 1_500,
            "the position did not move to the target"
        );
        unsafe { RoUninitialize() };
    }
}
