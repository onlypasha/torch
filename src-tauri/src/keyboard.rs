//! Global volume keys for the HUD and scoped Ctrl+V for the open Tray.
//!
//! Windows would normally turn `VK_VOLUME_UP`/`DOWN`/`MUTE` into its own
//! flyout and a 2% step. The notch wants sixteen 6.25% steps, so a low-level
//! keyboard hook swallows those three keys and a worker applies the step
//! through Core Audio instead. The hook runs on every desktop, not only while
//! the notch is focused - the window is `WS_EX_NOACTIVATE` and may be
//! click-through, and the user still expects the keys to work.
//!
//! The hook is deliberately only an observer of *hardware* keys: injected
//! events pass through, so automation and other remappers are not broken.
//!
//! Brightness is absent here on purpose. The probe in `examples/keyprobe.rs`
//! showed that this laptop's Fn brightness keys never reach either the
//! low-level hook or the raw-input consumer collection - the ASUS firmware
//! handles them itself - so `hud.rs` observes the panel's resulting level
//! instead of pretending to intercept a key that is not there.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::volume;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, HHOOK, KBDLLHOOKSTRUCT, MSG, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

/// Emitted after every volume step and every mute toggle.
pub const VOLUME_EVENT: &str = "hud-volume";

const VK_VOLUME_MUTE: u32 = 0xAD;
const VK_VOLUME_DOWN: u32 = 0xAE;
const VK_VOLUME_UP: u32 = 0xAF;
/// `LLKHF_INJECTED`; injected keys are left to the rest of the desktop.
const INJECTED: u32 = 0x10;

/// What the webview needs to draw the HUD. Every field comes back from the
/// endpoint after the write, so a refused or clamped change cannot look like a
/// success.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeEvent {
    pub level: f32,
    pub muted: bool,
    /// The key was already at 0 or 100 and the level did not move.
    pub limited: bool,
    pub failed: bool,
}

enum Message {
    TrayPaste,
    Step { direction: i32, shift: bool },
    Mute,
    Release { direction: i32 },
}

static NOTIFY: OnceLock<Sender<Message>> = OnceLock::new();
static HOOK_KEYS: AtomicBool = AtomicBool::new(false);
static UP_DOWN: AtomicBool = AtomicBool::new(false);
static DOWN_DOWN: AtomicBool = AtomicBool::new(false);
static MUTE_DOWN: AtomicBool = AtomicBool::new(false);
static TRAY_ACTIVE: AtomicBool = AtomicBool::new(false);
static PASTE_DOWN: AtomicBool = AtomicBool::new(false);

pub fn set_tray_active(active: bool) {
    TRAY_ACTIVE.store(active, Ordering::Relaxed);
}

fn volume_event(
    step: Result<volume::Step, String>,
    last: &mut Option<volume::Volume>,
) -> VolumeEvent {
    match step {
        Ok(step) => {
            *last = Some(step.volume);
            VolumeEvent {
                level: step.volume.level,
                muted: step.volume.muted,
                limited: step.limited,
                failed: false,
            }
        }
        Err(error) => {
            eprintln!("volume key failed: {error}");
            let fallback = (*last)
                .or_else(|| volume::get().ok())
                .unwrap_or(volume::Volume {
                    level: 0.0,
                    muted: false,
                });
            *last = Some(fallback);
            VolumeEvent {
                level: fallback.level,
                muted: fallback.muted,
                limited: false,
                failed: true,
            }
        }
    }
}

/// The repeat lives here rather than in the webview: 350ms before the first
/// repeat, then one step every 90ms while the key is held. Keeping it on this
/// thread means a busy UI cannot stretch the cadence.
fn worker(app: AppHandle, messages: std::sync::mpsc::Receiver<Message>) {
    let mut last: Option<volume::Volume> = volume::get().ok();
    // `None` = no key held; `Some` = which direction, its shift state, and when
    // the next repeat is due.
    let mut held: Option<(i32, bool, Instant)> = None;

    loop {
        let message = match held {
            Some((_, _, due)) => {
                let wait = due.saturating_duration_since(Instant::now());
                match messages.recv_timeout(wait) {
                    Ok(message) => message,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let (direction, shift, _) = held.expect("held");
                        let event = volume_event(volume::step(direction, shift), &mut last);
                        let _ = app.emit(VOLUME_EVENT, event);
                        held = Some((direction, shift, Instant::now() + Duration::from_millis(90)));
                        continue;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match messages.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };

        match message {
            Message::TrayPaste => {
                let _ = app.emit("tray-paste-request", ());
            }
            Message::Step { direction, shift } => {
                // A different key pressed while one is held starts its own
                // hold; the hook has already filtered that key's auto-repeat.
                if held.map(|(dir, _, _)| dir) == Some(direction) {
                    continue;
                }
                let event = volume_event(volume::step(direction, shift), &mut last);
                let _ = app.emit(VOLUME_EVENT, event);
                held = Some((
                    direction,
                    shift,
                    Instant::now() + Duration::from_millis(350),
                ));
            }
            Message::Mute => {
                let event = volume_event(volume::toggle_mute(), &mut last);
                let _ = app.emit(VOLUME_EVENT, event);
                held = None;
            }
            Message::Release { direction } => {
                if held.map(|(dir, _, _)| dir) == Some(direction) {
                    held = None;
                }
            }
        }
    }
}

/// Runs on the hook thread, so it only marks state and hands a message over.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(message, WM_KEYUP | WM_SYSKEYUP);

        // The overlay deliberately never takes foreground keyboard focus.
        // Route only Ctrl+V while its Tray is open, and consume the matching
        // repeat/release so the underlying application cannot paste as well.
        if down || up {
            if let Some(info) = unsafe { (lparam.0 as *const KBDLLHOOKSTRUCT).as_ref() } {
                if info.flags.0 & INJECTED == 0 && info.vkCode == u32::from(b'V') {
                    if up && PASTE_DOWN.swap(false, Ordering::Relaxed) {
                        return LRESULT(1);
                    }
                    if down && PASTE_DOWN.load(Ordering::Relaxed) {
                        return LRESULT(1);
                    }
                    let held = |key: i32| unsafe { GetAsyncKeyState(key) } < 0;
                    if down
                        && TRAY_ACTIVE.load(Ordering::Relaxed)
                        && crate::mouse_hook::is_open()
                        && held(VK_CONTROL.0 as i32)
                        && !held(VK_MENU.0 as i32)
                        && !held(VK_LWIN.0 as i32)
                        && !held(VK_RWIN.0 as i32)
                    {
                        PASTE_DOWN.store(true, Ordering::Relaxed);
                        if let Some(tx) = NOTIFY.get() {
                            let _ = tx.send(Message::TrayPaste);
                        }
                        return LRESULT(1);
                    }
                }
            }
        }

        if (down || up) && HOOK_KEYS.load(Ordering::Relaxed) {
            if let Some(info) = unsafe { (lparam.0 as *const KBDLLHOOKSTRUCT).as_ref() } {
                if info.flags.0 & INJECTED == 0 {
                    let (slot, direction) = match info.vkCode {
                        VK_VOLUME_UP => (&UP_DOWN, 1),
                        VK_VOLUME_DOWN => (&DOWN_DOWN, -1),
                        VK_VOLUME_MUTE => (&MUTE_DOWN, 0),
                        _ => {
                            return unsafe {
                                CallNextHookEx(HHOOK::default(), code, wparam, lparam)
                            };
                        }
                    };

                    let was_down = slot.swap(down, Ordering::Relaxed);
                    if down && !was_down {
                        // A held key's auto-repeat is swallowed with the first
                        // press; the worker owns the cadence from here.
                        let shift =
                            unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) } as u16 & 0x8000 != 0;
                        let message = if direction == 0 {
                            Message::Mute
                        } else {
                            Message::Step { direction, shift }
                        };
                        if let Some(tx) = NOTIFY.get() {
                            let _ = tx.send(message);
                        }
                    } else if up && was_down && direction != 0 {
                        if let Some(tx) = NOTIFY.get() {
                            let _ = tx.send(Message::Release { direction });
                        }
                    }
                    // Swallow both halves, and the auto-repeats in between, so
                    // Windows' flyout never appears next to the notch's HUD.
                    return LRESULT(1);
                }
            }
        }
    }
    unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
}

pub fn install(app: &AppHandle) {
    // If there is no endpoint to move, leave the keys alone: swallowing them
    // would make the volume keys do nothing at all.
    if volume::get().is_err() {
        eprintln!("keyboard HUD disabled: no default audio endpoint");
    } else {
        HOOK_KEYS.store(true, Ordering::Relaxed);
    }

    let (tx, rx) = channel::<Message>();
    let _ = NOTIFY.set(tx);

    let emitter = app.clone();
    std::thread::spawn(move || worker(emitter, rx));

    std::thread::spawn(|| unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(_) => return,
        };
        let hook =
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE(module.0), 0) {
                Ok(hook) => hook,
                Err(error) => {
                    eprintln!("keyboard hook failed: {error}");
                    return;
                }
            };

        let mut message = MSG::default();
        while GetMessageW(&mut message, HWND::default(), 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = UnhookWindowsHookEx(hook);
    });
}
