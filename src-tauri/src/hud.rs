//! Brightness HUD signals.
//!
//! Unlike volume, the brightness keys on this machine cannot be intercepted:
//! `examples/keyprobe.rs` listened to both a low-level keyboard hook and the
//! raw-input consumer collection while the Fn keys were pressed, and saw
//! nothing at all. The ASUS firmware/OSD handles those keys before Windows
//! does, and there is no standard virtual key for brightness.
//!
//! What *is* observable is the panel's resulting level. This module polls the
//! fast LCD route and reports every change it sees, so the notch can show the
//! level Windows actually ended up at. It never writes: the step size is the
//! laptop's own, not a pretend 6.25%.

use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::sysinfo;


/// Emitted with the panel's new brightness, 0-100.
pub const BRIGHTNESS_EVENT: &str = "hud-brightness";

/// The last level the watcher has reported (or was told about). `-1` means no
/// sample yet, so the first poll becomes the baseline instead of raising a HUD
/// at startup.
static LAST: AtomicI32 = AtomicI32::new(-1);

/// Tell the watcher that a write it is about to see came from us, not from the
/// Fn key. Without this, closing the panel right after moving the slider could
/// make the HUD appear for a change the user just made deliberately.
pub fn note_brightness(value: i32) {
    LAST.store(value.clamp(0, 100), Ordering::Relaxed);
}

fn poll() -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        sysinfo::watch_brightness()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

pub fn install(app: &AppHandle) {
    if let Some(level) = poll() {
        LAST.store(level, Ordering::Relaxed);
    }

    let emitter = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(120));
        let Some(level) = poll() else { continue };
        let last = LAST.load(Ordering::Relaxed);
        if last != level {
            LAST.store(level, Ordering::Relaxed);
            let _ = emitter.emit(BRIGHTNESS_EVENT, level);
        }
    });
}
