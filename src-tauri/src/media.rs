//! The Nook's media panel, fed by Windows' own media session.
//!
//! `GlobalSystemMediaTransportControlsSessionManager` is the same API the
//! volume flyout uses: whichever app Windows itself considers to be playing is
//! the session shown here, so no player is special-cased and nothing is scraped.
//!
//! One worker thread owns the WinRT objects and polls them; every *command*
//! (previous / toggle / next) is sent to that same thread, because the session
//! object is only touched from the apartment it was created in. Everything the
//! webview needs is emitted as `media-state`, including the album art as a data
//! URL when the track changes.
//!
//! A session that exposes neither title nor artist still reports position; a
//! session with no media at all is reported as `null` so the panel can say so
//! rather than invent a song.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

pub const MEDIA_EVENT: &str = "media-state";
const POLL: Duration = Duration::from_millis(700);
/// Album art above this is refused rather than copied into a data URL; Windows
/// thumbnails are normally tens of kilobytes.
const MAX_ART_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPayload {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Always present while the track has art, so newly opened panels (or
    /// remounted webviews) never see a missing cover.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub can_previous: bool,
    pub can_next: bool,
    pub can_toggle: bool,
    pub source: String,
}

#[derive(Clone, Copy)]
pub enum Action {
    Previous,
    Toggle,
    Next,
}

pub struct Control(Sender<Action>);

impl Control {
    pub fn send(&self, action: Action) {
        let _ = self.0.send(action);
    }
}

fn track_key(
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> (String, String) {
    (
        props
            .Title()
            .map(|value| value.to_string_lossy())
            .unwrap_or_default(),
        props
            .Artist()
            .map(|value| value.to_string_lossy())
            .unwrap_or_default(),
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

/// One poll: the panel's model. `thumbnail` is provided directly from the
/// cached art for the current track.
fn snapshot(
    session: &GlobalSystemMediaTransportControlsSession,
    props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
    thumbnail: Option<String>,
) -> MediaPayload {
    let (title, artist) = track_key(props);
    let album = props
        .AlbumTitle()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();

    // One PlaybackInfo call answers both the status and the three buttons.
    let playback = session.GetPlaybackInfo().ok();
    let playing = playback
        .as_ref()
        .and_then(|info| info.PlaybackStatus().ok())
        .is_some_and(|status| {
            status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
        });

    let (mut position_ms, mut duration_ms) = (0u64, 0u64);
    if let Ok(timeline) = session.GetTimelineProperties() {
        let start = timeline.StartTime().map(|t| t.Duration as u64).unwrap_or(0);
        let end = timeline.EndTime().map(|t| t.Duration as u64).unwrap_or(0);
        let position = timeline.Position().map(|t| t.Duration as u64).unwrap_or(0);
        duration_ms = end.saturating_sub(start) / 10_000;
        // Position can sit a hair past the end at the very end of a track.
        position_ms =
            (position.saturating_sub(start) / 10_000).min(duration_ms.max(position / 10_000));
    }

    let controls = playback.as_ref().and_then(|info| info.Controls().ok());
    let (can_previous, can_next, can_toggle) = controls
        .as_ref()
        .map(|controls| {
            (
                controls.IsPreviousEnabled().unwrap_or(true),
                controls.IsNextEnabled().unwrap_or(true),
                controls.IsPlayPauseToggleEnabled().unwrap_or(true),
            )
        })
        .unwrap_or((true, true, true));

    MediaPayload {
        title,
        artist,
        album,
        playing,
        position_ms,
        duration_ms,
        thumbnail,
        can_previous,
        can_next,
        can_toggle,
        source: session
            .SourceAppUserModelId()
            .map(|value| value.to_string_lossy())
            .unwrap_or_default(),
    }
}

fn publish(app: &AppHandle, payload: Option<MediaPayload>) {
    if let Err(error) = app.emit(MEDIA_EVENT, payload) {
        eprintln!("emitting media state failed: {error}");
    }
}

/// Where the last *reported* position started, so position can be advanced
/// between Windows' own timeline updates. Players usually publish a position
/// when playback starts, pauses or seeks, not every second; without this the
/// panel's clock and bar would stand still between those events.
#[derive(Clone, Copy)]
struct Playhead {
    position: u64,
    at: Instant,
    playing: bool,
}

/// Returns the position to display now. A new reported position (or play/pause
/// change) becomes the new anchor; otherwise a playing track advances from the
/// anchor by wall-clock time. Paused tracks keep the reported position.
fn extrapolate(
    position_ms: u64,
    playing: bool,
    duration_ms: u64,
    now: Instant,
    playhead: &mut Option<Playhead>,
) -> u64 {
    match *playhead {
        Some(anchor) if anchor.playing == playing && anchor.position == position_ms => {
            if !playing {
                return position_ms;
            }
            let elapsed = now.saturating_duration_since(anchor.at).as_millis() as u64;
            let advanced = anchor.position.saturating_add(elapsed);
            if duration_ms > 0 {
                advanced.min(duration_ms)
            } else {
                advanced
            }
        }
        _ => {
            *playhead = Some(Playhead {
                position: position_ms,
                at: now,
                playing,
            });
            position_ms
        }
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

    // Remembered art: read once per track change, cached in memory, and
    // included with every poll so the open panel immediately sees the cover.
    let mut art_cache: Option<((String, String, String), Option<String>)> = None;
    let mut playhead: Option<Playhead> = None;
    let mut next_poll = Instant::now();

    loop {
        // Commands are executed on this thread, before the next poll, so the
        // panel's own state reflects the press on the next emit.
        match commands.recv_timeout(Duration::from_millis(80)) {
            Ok(Action::Previous) => {
                if let Ok(session) = manager.GetCurrentSession() {
                    let _ = session.TrySkipPreviousAsync().and_then(|op| op.get());
                }
                next_poll = Instant::now();
            }
            Ok(Action::Next) => {
                if let Ok(session) = manager.GetCurrentSession() {
                    let _ = session.TrySkipNextAsync().and_then(|op| op.get());
                }
                next_poll = Instant::now();
            }
            Ok(Action::Toggle) => {
                if let Ok(session) = manager.GetCurrentSession() {
                    let _ = session.TryTogglePlayPauseAsync().and_then(|op| op.get());
                }
                next_poll = Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }

        if Instant::now() >= next_poll {
            let mut payload = None;
            let current = manager.GetCurrentSession().ok();
            let properties = current.as_ref().and_then(|session| {
                session
                    .TryGetMediaPropertiesAsync()
                    .ok()
                    .and_then(|operation| operation.get().ok())
            });
            if let (Some(session), Some(props)) = (current.as_ref(), properties.as_ref()) {
                let source = session
                    .SourceAppUserModelId()
                    .map(|value| value.to_string_lossy())
                    .unwrap_or_default();
                let (title, artist) = track_key(props);
                let key = (title, artist, source);

                let thumb = match &art_cache {
                    Some((cached_key, cached_thumb)) if cached_key == &key => {
                        cached_thumb.clone()
                    }
                    _ => {
                        let fresh = props.Thumbnail().ok().and_then(|art| album_art(&art));
                        art_cache = Some((key, fresh.clone()));
                        fresh
                    }
                };

                payload = Some(snapshot(session, props, thumb));
            }
            if payload.is_none() {
                art_cache = None;
                playhead = None;
            }
            let payload = payload.map(|mut value| {
                value.position_ms = extrapolate(
                    value.position_ms,
                    value.playing,
                    value.duration_ms,
                    Instant::now(),
                    &mut playhead,
                );
                value
            });
            publish(&app, payload);
            next_poll = Instant::now() + POLL;
        }
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

/// The webview's three transport controls. Unknown actions are rejected so the
/// command surface stays exactly as wide as the panel's buttons.
pub fn command(control: &Control, action: &str) -> Result<(), String> {
    match action {
        "previous" => control.send(Action::Previous),
        "toggle" => control.send(Action::Toggle),
        "next" => control.send(Action::Next),
        _ => return Err(format!("unknown media action: {action}")),
    }
    Ok(())
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
    fn playhead_advances_only_while_playing_and_reanchors() {
        let now = Instant::now();

        let mut playing = Some(Playhead {
            position: 30_000,
            at: now - Duration::from_millis(2_500),
            playing: true,
        });
        assert_eq!(
            extrapolate(30_000, true, 180_000, now, &mut playing),
            32_500
        );
        // Never past the reported duration.
        assert_eq!(extrapolate(30_000, true, 31_000, now, &mut playing), 31_000);

        let mut paused = Some(Playhead {
            position: 30_000,
            at: now - Duration::from_secs(5),
            playing: false,
        });
        assert_eq!(
            extrapolate(30_000, false, 180_000, now, &mut paused),
            30_000
        );

        // Resume must not count the paused time.
        assert_eq!(extrapolate(30_000, true, 180_000, now, &mut paused), 30_000);

        // A seek (or the player publishing a new position) resets the anchor.
        let mut fresh: Option<Playhead> = None;
        assert_eq!(extrapolate(40_000, true, 180_000, now, &mut fresh), 40_000);
        assert_eq!(extrapolate(41_000, true, 180_000, now, &mut fresh), 41_000);
    }

    #[test]
    #[ignore = "manual passive Windows media-session probe (no playback started)"]
    fn media_windows_probe() {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).unwrap() };
        let manager = windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .expect("media session manager");
        match manager.GetCurrentSession() {
            Ok(session) => {
                let props = session
                    .TryGetMediaPropertiesAsync()
                    .and_then(|op| op.get())
                    .expect("media properties");
                let thumb = props.Thumbnail().ok().and_then(|art| album_art(&art));
                let payload = snapshot(&session, &props, thumb);
                println!(
                    "title={:?} artist={:?} playing={} {}/{}ms art={} source={}",
                    payload.title,
                    payload.artist,
                    payload.playing,
                    payload.position_ms,
                    payload.duration_ms,
                    payload.thumbnail.as_ref().map(|art| art.len()).unwrap_or(0),
                    payload.source
                );
            }
            Err(error) => println!("no current session: {error}"),
        }
        unsafe { RoUninitialize() };
    }
}
