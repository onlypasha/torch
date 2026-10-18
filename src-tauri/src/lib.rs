//! Windows notch overlay - foundation layer.
//!
//! This module owns everything native: window styling, positioning, the
//! click-through state and the mouse hook. UI behaviour lives in the webview.
//!
//! Three Windows behaviours were *measured* here rather than assumed, and they
//! shape the whole design:
//!
//! 1. Resizing the native window makes WebView2 re-create its surface, which
//!    blanks the notch for ~2 frames (~35 ms) on every shrink. So the window
//!    keeps the expanded size for its whole life and never resizes.
//! 2. The webview receives mouse events over fully transparent pixels, so an
//!    unmodified collapsed window would quietly swallow desktop clicks across
//!    the whole 400x180 block.
//! 3. Neither a window region (`SetWindowRgn`) nor answering `WM_NCHITTEST`
//!    restrains that: the region is ignored by Tauri's composition-based window
//!    (painting and hit-testing both unchanged), and the parent window procedure
//!    never even sees `WM_NCHITTEST` because WebView2 delivers input through its
//!    own composition path.
//!
//! What does work is `WS_EX_TRANSPARENT | WS_EX_LAYERED`, which makes the whole
//! window click-through without disturbing the composited rendering. The
//! collapsed window is therefore fully click-through, and the low-level mouse
//! hook is what notices a click on the notch - and *swallows* it, so the click
//! does not leak into whatever application is underneath.

use tauri::menu::{Menu, MenuItem};
use tauri::{Manager, WebviewWindow};

/// Sizes are given in logical pixels; the physical conversion happens here so
/// the webview never has to think about DPI.
const INITIAL_WIDTH: f64 = 400.0;
const INITIAL_HEIGHT: f64 = 180.0;

/// Startup hit area: must match COLLAPSED in src/App.tsx. The frontend re-asserts
/// the same values as soon as it mounts, this is only so the window does not
/// swallow clicks in the first few frames after launch.
const INITIAL_NOTCH: (f64, f64) = (180.0, 32.0);

#[cfg(target_os = "windows")]
mod win {
    pub use platform_impl::*;

    mod platform_impl {
        use tauri::WebviewWindow;

        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowLongW, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowLongW,
            SetWindowPos, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        };

        pub fn raw(window: &WebviewWindow) -> Option<HWND> {
            window.hwnd().ok().map(|h| HWND(h.0 as _))
        }

        /// Transparent, borderless and *never* focusable: the notch must not
        /// steal focus from whatever the user is actually working in.
        pub fn apply_styles(window: &WebviewWindow) {
            let Some(hwnd) = raw(window) else { return };
            unsafe {
                let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
                let next = ex | WS_EX_NOACTIVATE.0 as i32 | WS_EX_TOOLWINDOW.0 as i32;
                let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, next);
            }
        }

        /// Move/resize without activating and without touching z-order.
        pub fn place(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) -> windows::core::Result<()> {
            unsafe {
                SetWindowPos(hwnd, HWND::default(), x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)
            }
        }

        /// Toggle click-through. `WS_EX_LAYERED` is what makes the system honour
        /// `WS_EX_TRANSPARENT` for hit-testing; measured to leave the composited
        /// rendering untouched.
        pub fn set_click_through(window: &WebviewWindow, enabled: bool) {
            let Some(hwnd) = raw(window) else { return };
            unsafe {
                let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
                let bits = WS_EX_LAYERED.0 as i32 | WS_EX_TRANSPARENT.0 as i32;
                let next = if enabled { ex | bits } else { ex & !bits };
                if next != ex {
                    let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, next);
                }
            }
        }
    }
}

/// Position the window horizontally centred on its monitor and flush with the
/// top edge. `width`/`height` are logical pixels.
#[tauri::command]
fn set_notch_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;

    let scale = monitor.scale_factor();
    let logical_width = monitor.size().width as f64 / scale;
    let origin = monitor.position();

    let x = origin.x as f64 / scale + (logical_width - width) / 2.0;
    let y = origin.y as f64 / scale;

    #[cfg(target_os = "windows")]
    if let Some(hwnd) = win::raw(&window) {
        return win::place(
            hwnd,
            (x * scale).round() as i32,
            (y * scale).round() as i32,
            (width * scale).round() as i32,
            (height * scale).round() as i32,
        )
        .map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tauri::{LogicalPosition, LogicalSize};
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        return window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string());
    }

    #[allow(unreachable_code)]
    Err("no hwnd".into())
}

/// Geometry of the collapsed notch, in physical pixels. The hook needs it to
/// recognise a click on the notch while the whole window is click-through.
#[cfg(target_os = "windows")]
mod notch_geometry {
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

    static COLLAPSED: AtomicBool = AtomicBool::new(false);
    static WIDTH: AtomicI32 = AtomicI32::new(0);
    static HEIGHT: AtomicI32 = AtomicI32::new(0);

    pub fn set(collapsed: bool, width: i32, height: i32) {
        WIDTH.store(width, Ordering::Relaxed);
        HEIGHT.store(height, Ordering::Relaxed);
        COLLAPSED.store(collapsed, Ordering::Relaxed);
    }

    pub fn is_collapsed() -> bool {
        COLLAPSED.load(Ordering::Relaxed)
    }

    /// Screen-space rect of the collapsed notch: centred horizontally in the
    /// window and flush with its top edge, matching the webview layout.
    pub fn rect(window: &windows::Win32::Foundation::RECT) -> (i32, i32, i32, i32) {
        let width = WIDTH.load(Ordering::Relaxed);
        let height = HEIGHT.load(Ordering::Relaxed);
        let window_width = window.right - window.left;
        let left = window.left + (window_width - width) / 2;
        (left, window.top, left + width, window.top + height)
    }
}

/// Restrict or release the click-through state. `width <= 0` means the panel is
/// open (or animating), so the whole window must accept input again. Values are
/// logical pixels.
#[tauri::command]
fn set_notch_hit(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let collapsing = width > 0.0 && height > 0.0;

        if collapsing {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            notch_geometry::set(
                true,
                (width * scale).round() as i32,
                (height * scale).round() as i32,
            );
        } else {
            notch_geometry::set(false, 0, 0);
        }

        win::set_click_through(&window, collapsing);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, width, height);
        Ok(())
    }
}

// The window is WS_EX_NOACTIVATE, and while collapsed it is fully click-through,
// so it never sees the clicks that land on other applications - or on itself.
// A low-level mouse hook is therefore the only way to notice both "the user
// clicked the notch" and "the user clicked away", and it is also what lets the
// notch click be swallowed instead of leaking to the window underneath.
#[cfg(target_os = "windows")]
mod mouse_hook {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::mpsc::Sender;

    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, GetWindowRect, HHOOK, MSG, MSLLHOOKSTRUCT,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONDOWN,
        WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    /// Fired when the panel is open and the user clicks anywhere outside it.
    pub const OUTSIDE_EVENT: &str = "notch-click-outside";
    /// Fired when the user clicks the collapsed notch (the click is swallowed).
    pub const PRESS_EVENT: &str = "notch-press";
    /// Fired when the user right-clicks the collapsed notch (also swallowed).
    pub const CONTEXT_EVENT: &str = "notch-context";

    enum Signal {
        Outside,
        Press,
        Context,
    }

    static NOTIFY: OnceLock<Sender<Signal>> = OnceLock::new();
    static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
    static OPEN: AtomicBool = AtomicBool::new(false);
    /// Set while the notch context menu is up. That menu is modal and its clicks
    /// come through this same hook, so the hook has to stand down completely or
    /// it would read a click on a menu item as a click on the notch.
    static MENU_OPEN: AtomicBool = AtomicBool::new(false);
    /// Set while we swallow a notch click, so the matching button-up is
    /// swallowed too and the application underneath never sees half a click.
    static SWALLOW_L_UP: AtomicBool = AtomicBool::new(false);
    /// A right-press on the collapsed notch, waiting for its release.
    static PENDING_R_UP: AtomicBool = AtomicBool::new(false);

    pub fn set_panel_open(open: bool) {
        OPEN.store(open, Ordering::Relaxed);
        if !open {
            SWALLOW_L_UP.store(false, Ordering::Relaxed);
        }
    }

    pub fn set_menu_open(open: bool) {
        MENU_OPEN.store(open, Ordering::Relaxed);
    }

    fn window_rect() -> Option<RECT> {
        let raw = TARGET_HWND.load(Ordering::Relaxed);
        if raw == 0 {
            return None;
        }
        let mut rect = RECT::default();
        unsafe { GetWindowRect(HWND(raw), &mut rect).ok()? };
        Some(rect)
    }

    /// The hook thread must stay allocation- and IPC-free, so a signal is just
    /// handed to the emitter thread and forgotten.
    fn notify(signal: Signal) {
        if let Some(tx) = NOTIFY.get() {
            let _ = tx.send(signal);
        }
    }

    /// True when the point is inside the collapsed notch silhouette.
    fn inside_collapsed_notch(rect: &RECT, x: i32, y: i32) -> bool {
        if !super::notch_geometry::is_collapsed() {
            return false;
        }
        let (nl, nt, nr, nb) = super::notch_geometry::rect(rect);
        x >= nl && x < nr && y >= nt && y < nb
    }

    /// Runs on the hook thread.
    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && !MENU_OPEN.load(Ordering::Relaxed) {
            let message = wparam.0 as u32;

            if message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN {
                if let Some(info) = unsafe { (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() } {
                    let POINT { x, y } = info.pt;
                    if let Some(rect) = window_rect() {
                        if OPEN.load(Ordering::Relaxed) {
                            // The panel is interactive, so only a click outside
                            // it matters - and that one is never swallowed.
                            let inside = x >= rect.left
                                && x < rect.right
                                && y >= rect.top
                                && y < rect.bottom;
                            if !inside {
                                notify(Signal::Outside);
                            }
                        } else if inside_collapsed_notch(&rect, x, y) {
                            // The collapsed window is click-through, so this
                            // click never reaches the webview: swallow it so it
                            // does not reach the window below either. A right
                            // press only arms the release; the menu is opened
                            // there, because a menu shown while the button is
                            // still down can dismiss itself immediately.
                            if message == WM_RBUTTONDOWN {
                                PENDING_R_UP.store(true, Ordering::Relaxed);
                            } else {
                                notify(Signal::Press);
                                SWALLOW_L_UP.store(true, Ordering::Relaxed);
                            }
                            return LRESULT(1);
                        }
                    }
                }
            } else if message == WM_LBUTTONUP && SWALLOW_L_UP.swap(false, Ordering::Relaxed) {
                return LRESULT(1);
            } else if message == WM_RBUTTONUP && PENDING_R_UP.swap(false, Ordering::Relaxed) {
                notify(Signal::Context);
                return LRESULT(1);
            }
        }
        unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
    }

    pub fn install(app: &tauri::AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            if let Some(hwnd) = super::win::raw(&window) {
                TARGET_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
            }
        }

        let (tx, rx) = std::sync::mpsc::channel::<Signal>();
        let _ = NOTIFY.set(tx);

        let emitter = app.clone();
        std::thread::spawn(move || {
            for signal in rx {
                let event = match signal {
                    Signal::Outside => OUTSIDE_EVENT,
                    Signal::Press => PRESS_EVENT,
                    Signal::Context => CONTEXT_EVENT,
                };
                let _ = emitter.emit(event, ());
            }
        });

        std::thread::spawn(|| unsafe {
            let module = match GetModuleHandleW(None) {
                Ok(module) => module,
                Err(_) => return,
            };
            let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE(module.0), 0)
            {
                Ok(hook) => hook,
                Err(_) => return,
            };

            let mut msg = MSG::default();
            // GetMessageW returns 0 on WM_QUIT and -1 on error: stop on both.
            while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
        });
    }
}

/// Kept as a plain function so `setup` and the commands share one code path.
#[tauri::command]
fn set_panel_open(open: bool) {
    #[cfg(target_os = "windows")]
    mouse_hook::set_panel_open(open);
    #[cfg(not(target_os = "windows"))]
    let _ = open;
}

/// Menu id for the exit entry, matched in the menu event handler below.
const EXIT_MENU_ID: &str = "exit";

/// Show the notch context menu at the cursor. Deliberately synchronous so it
/// runs on the main thread - `TrackPopupMenu` needs the thread that owns the
/// window - and deliberately only one entry wide for now.
#[tauri::command]
fn show_notch_menu(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    mouse_hook::set_menu_open(true);

    let shown = (|| -> tauri::Result<()> {
        let exit = MenuItem::with_id(window.app_handle(), EXIT_MENU_ID, "Exit", true, None::<&str>)?;
        let menu = Menu::with_items(window.app_handle(), &[&exit])?;
        window.popup_menu(&menu)
    })();

    #[cfg(target_os = "windows")]
    mouse_hook::set_menu_open(false);

    shown.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_menu_event(|app, event| {
            if event.id().as_ref() == EXIT_MENU_ID {
                app.exit(0);
            }
        })
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;

            #[cfg(target_os = "windows")]
            {
                win::apply_styles(&window);
                mouse_hook::install(app.handle());
            }

            // Place it top-centre immediately so the first frames are already
            // in the right spot instead of flashing at the default position.
            set_notch_size(window.clone(), INITIAL_WIDTH, INITIAL_HEIGHT)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            #[cfg(target_os = "windows")]
            {
                let (w, h) = INITIAL_NOTCH;
                win::set_click_through(&window, true);
                let scale = window.scale_factor().unwrap_or(1.0);
                notch_geometry::set(
                    true,
                    (w * scale).round() as i32,
                    (h * scale).round() as i32,
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_notch_size,
            set_notch_hit,
            set_panel_open,
            show_notch_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
