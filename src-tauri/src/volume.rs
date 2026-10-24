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
    #[ignore = "manual Windows probe: reads the default render endpoint"]
    fn volume_windows_probe() {
        println!("{:?}", get());
    }
}
