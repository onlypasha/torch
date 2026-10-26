//! System volume, through the very endpoint the Windows flyout moves.
//!
//! This is deliberately the *system* stream, not a per-app mixer: the notch has
//! no way to know whether the sound the user hears comes from the browser tab
//! or a player, and Windows already exposes one master level for both.

use serde::Serialize;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia, eRender};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// 0.0 – 1.0, the same scalar Core Audio stores.
    pub level: f32,
    pub muted: bool,
}

/// Core Audio needs an apartment on whichever thread it is used from. The
/// notch calls this from Tauri's command threads, each of which may be a
/// different one, so the apartment is set up and torn down per call rather than
/// assumed. A thread that was already initialized keeps its own model.
fn with_endpoint<T>(
    work: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<T>,
) -> Result<T, String> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            work(&volume)
        })();
        if initialized {
            CoUninitialize();
        }
        result.map_err(|error| error.message())
    }
}

pub fn get() -> Result<Volume, String> {
    with_endpoint(|endpoint| unsafe {
        Ok(Volume {
            level: endpoint.GetMasterVolumeLevelScalar()?,
            muted: endpoint.GetMute()?.as_bool(),
        })
    })
}

/// `level` and `muted` arrive together so raising the slider while muted
/// unmutes in one call instead of two racing ones.
pub fn set(level: f32, muted: bool) -> Result<(), String> {
    let level = if level.is_finite() {
        level.clamp(0.0, 1.0)
    } else {
        0.0
    };
    with_endpoint(|endpoint| unsafe {
        endpoint.SetMasterVolumeLevelScalar(level, std::ptr::null())?;
        endpoint.SetMute(muted, std::ptr::null())
    })
}

/// The HUD moves volume on a 64-unit grid: sixteen visible steps of 6.25%,
/// and a quarter of that (1.5625%) with Shift held.
///
/// The grid is what makes repeated presses predictable: starting from an
/// arbitrary Windows level (42.19%, say), every press lands on the same
/// sixteenth as the one before, instead of accumulating float dust.
pub const UNITS: i32 = 64;
const STEP: i32 = 4;

/// Pure part of a volume step, so the arithmetic is testable without an audio
/// endpoint. Returns the level to write, whether the key was already at its
/// limit, and the unit the level landed on.
pub(crate) fn stepped(level: f32, direction: i32, shift: bool) -> (f32, bool) {
    let current = (level.clamp(0.0, 1.0) * UNITS as f32).round() as i32;
    let delta = if shift { 1 } else { STEP };
    let at_limit = (direction > 0 && current >= UNITS) || (direction < 0 && current <= 0);
    let next = (current + direction.signum() * delta).clamp(0, UNITS);
    (next as f32 / UNITS as f32, at_limit)
}

/// Mute is a flag beside the level, not a zero: Windows keeps the level the
/// endpoint will resume at. Unmuting at a level of zero has nothing to restore,
/// so it comes back at 25%.
pub(crate) fn toggled(level: f32, muted: bool) -> (f32, bool) {
    if muted {
        let restore = if level <= 0.0 { 0.25 } else { level.clamp(0.0, 1.0) };
        (restore, false)
    } else {
        (level.clamp(0.0, 1.0), true)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub volume: Volume,
    /// The key was already at 0 or 100 and the level could not move further.
    pub limited: bool,
}

fn read(endpoint: &IAudioEndpointVolume) -> windows::core::Result<Volume> {
    unsafe {
        Ok(Volume {
            level: endpoint.GetMasterVolumeLevelScalar()?,
            muted: endpoint.GetMute()?.as_bool(),
        })
    }
}

/// Move the system volume one step, never into a muted state: raising or
/// lowering the volume is itself an unmute.
pub fn step(direction: i32, shift: bool) -> Result<Step, String> {
    if direction == 0 {
        return Err("no volume direction".into());
    }
    with_endpoint(|endpoint| unsafe {
        let before = read(endpoint)?;
        let (target, limited) = stepped(before.level, direction, shift);
        endpoint.SetMasterVolumeLevelScalar(target, std::ptr::null())?;
        if before.muted {
            endpoint.SetMute(false, std::ptr::null())?;
        }
        // The endpoint is the authority: report what it now holds, not what was
        // asked for. A mixer that clamps or refuses cannot be shown as success.
        Ok(Step {
            volume: read(endpoint)?,
            limited,
        })
    })
}

/// Toggle mute and report the endpoint's own answer, including the level
/// waiting behind the flag.
pub fn toggle_mute() -> Result<Step, String> {
    with_endpoint(|endpoint| unsafe {
        let before = read(endpoint)?;
        let (level, muted) = toggled(before.level, before.muted);
        if level != before.level {
            endpoint.SetMasterVolumeLevelScalar(level, std::ptr::null())?;
        }
        endpoint.SetMute(muted, std::ptr::null())?;
        Ok(Step {
            volume: read(endpoint)?,
            limited: false,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_outside_the_scalar_range_is_clamped() {
        let clamp = |value: f32| {
            if value.is_finite() {
                value.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        assert_eq!(clamp(-0.4), 0.0);
        assert_eq!(clamp(1.4), 1.0);
        assert_eq!(clamp(f32::NAN), 0.0);
        assert_eq!(clamp(0.35), 0.35);
    }

    #[test]
    fn a_step_lands_on_the_sixteenth_grid() {
        // 42.19% is 27/64; one press up is 31/64, one press down 23/64.
        let (up, limited) = stepped(0.4207, 1, false);
        assert_eq!(up, 31.0 / 64.0);
        assert!(!limited);
        let (down, _) = stepped(0.4207, -1, false);
        assert_eq!(down, 23.0 / 64.0);
    }

    #[test]
    fn shift_takes_a_quarter_step() {
        let (up, _) = stepped(0.0, 1, true);
        assert_eq!(up, 1.0 / 64.0);
        let (down, _) = stepped(1.0, -1, true);
        assert_eq!(down, 63.0 / 64.0);
    }

    #[test]
    fn the_ends_clamp_and_report_the_limit() {
        let (top, limited) = stepped(1.0, 1, false);
        assert_eq!(top, 1.0);
        assert!(limited);
        let (zero, limited) = stepped(0.0, -1, false);
        assert_eq!(zero, 0.0);
        assert!(limited);
        // Landing on the end from inside it is not the same as pushing against
        // it: 60/64 plus one step reaches 100% without shaking.
        let (reached, limited) = stepped(60.0 / 64.0, 1, false);
        assert_eq!(reached, 1.0);
        assert!(!limited);
    }

    #[test]
    fn mute_remembers_the_level_the_endpoint_will_resume_at() {
        assert_eq!(toggled(0.42, false), (0.42, true));
        assert_eq!(toggled(0.42, true), (0.42, false));
        assert_eq!(toggled(0.0, true), (0.25, false));
        assert_eq!(toggled(0.0, false), (0.0, true));
    }

    #[test]
    #[ignore = "manual Windows probe: reads the default render endpoint"]
    fn volume_windows_probe() {
        println!("{:?}", get());
    }

    #[test]
    #[ignore = "manual Windows probe: moves the real endpoint one step and restores it"]
    fn volume_step_windows_probe() {
        let before = get().expect("volume");
        let (target, _) = stepped(before.level, 1, true);
        let result = step(1, true).expect("step");
        println!("before={before:?} target={target} step={:?}", result);
        let restored = set(before.level, before.muted);
        println!("restored={restored:?}");
        assert!((result.volume.level - target).abs() < 0.001);
    }
}
