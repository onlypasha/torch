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
//!    the whole window.
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
//!
//! 4. A foreground window that covers the collapsed notch makes it slide away
//!    (autohide), and it only comes back when the cursor is bumped against the
//!    top edge. That is a separate concern from click-through: while hidden
//!    there is nothing to click, so the hook stops swallowing and the press
//!    falls through to the covering application.

use tauri::menu::{Menu, MenuItem};
use tauri::{Manager, WebviewWindow};

/// The window is deliberately larger than the expanded panel: the opening
/// spring overshoots by ~4.5% of its travel (420x160 reaches roughly 430x166),
/// and the window is never resized mid-animation, so that room has to exist
/// from the start. The margins are transparent and, while the panel is open,
/// they are what the hook treats as "outside".
const INITIAL_WIDTH: f64 = 480.0;
const INITIAL_HEIGHT: f64 = 220.0;

/// Startup silhouette: must match COLLAPSED in src/App.tsx. The frontend
/// re-asserts the same values as soon as it mounts; this is only so the window
/// does not swallow clicks in the first few frames after launch.
const INITIAL_NOTCH: (f64, f64) = (200.0, 34.0);

/// Activity indicators - charger, network, Bluetooth, USB - and the events they
/// raise for the webview to display in place of the clock.
#[cfg(target_os = "windows")]
mod activity;

/// The charger's state, shared by the `notch-power` event that keeps the dot on
/// the bar alive and by the `power_state` command the webview calls when it
/// mounts. It lives here rather than inside the Windows-only `activity` module so
/// the command keeps one signature on every target.
#[derive(Clone, serde::Serialize)]
pub struct PowerState {
    pub plugged: bool,
    /// Already formatted for display, as `"79%"`, or empty when Windows will not
    /// say - which is what a desktop with no battery reports.
    pub percentage: String,
}

/// The charger's state right now. The watcher reports every *change* on its own,
/// but its first poll can happen before the webview has a listener, and a machine
/// that was already charging would then keep its dot hidden until the cable
/// moved again. The webview asks once on mount and listens after that.
#[tauri::command]
fn power_state() -> Option<PowerState> {
    #[cfg(target_os = "windows")]
    {
        activity::power_snapshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

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

/// Geometry of the current notch silhouette, in physical pixels. The hook needs
/// it both to recognise a click on the collapsed notch (while the whole window
/// is click-through) and to tell a click inside the open panel from a click
/// that should close it.
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

    /// Screen-space rect of the silhouette: centred horizontally in the window
    /// and flush with its top edge, matching the webview layout.
    pub fn rect(window: &windows::Win32::Foundation::RECT) -> (i32, i32, i32, i32) {
        let width = WIDTH.load(Ordering::Relaxed);
        let height = HEIGHT.load(Ordering::Relaxed);
        let window_width = window.right - window.left;
        let left = window.left + (window_width - width) / 2;
        (left, window.top, left + width, window.top + height)
    }
}

/// Tell the native side which silhouette is currently on screen, in logical
/// pixels, and whether the window should be click-through. Collapsed is
/// click-through (the hook feeds the webview the clicks instead); expanded
/// keeps the whole window interactive.
#[tauri::command]
fn set_notch_hit(
    window: WebviewWindow,
    width: f64,
    height: f64,
    click_through: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        notch_geometry::set(
            click_through,
            (width * scale).round() as i32,
            (height * scale).round() as i32,
        );
        win::set_click_through(&window, click_through);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, width, height, click_through);
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

    pub(crate) fn is_open() -> bool {
        OPEN.load(Ordering::Relaxed)
    }

    pub(crate) fn target_hwnd() -> HWND {
        HWND(TARGET_HWND.load(Ordering::Relaxed))
    }

    pub(crate) fn window_rect() -> Option<RECT> {
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

    /// Runs on the hook thread.
    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && !MENU_OPEN.load(Ordering::Relaxed) {
            let message = wparam.0 as u32;

            if message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN {
                if let Some(info) = unsafe { (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() } {
                    let POINT { x, y } = info.pt;
                    if let Some(rect) = window_rect() {
                        // The silhouette is the panel while it is open and the
                        // notch bar while it is collapsed, so one rect answers
                        // both questions.
                        let (pl, pt, pr, pb) = super::notch_geometry::rect(&rect);
                        let inside = x >= pl && x < pr && y >= pt && y < pb;

                        if OPEN.load(Ordering::Relaxed) {
                            // The window has transparent margins for the spring
                            // overshoot, so "outside the window" is not the same
                            // as "outside the panel".
                            if !inside {
                                notify(Signal::Outside);
                            }
                        } else if super::notch_geometry::is_collapsed()
                            && !super::autohide::is_hidden()
                            && inside
                        {
                            // The collapsed window is click-through, so this
                            // click never reaches the webview: swallow it so it
                            // does not reach the window below either. A right
                            // press only arms the release; the menu is opened
                            // there, because a menu shown while the button is
                            // still down can dismiss itself immediately.
                            //
                            // While the notch is auto-hidden there is no notch
                            // to click: the press must fall through to whatever
                            // application is on top, exactly like the WPF
                            // original did.
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

/// Autohide, ported from the WPF original (`MainWindow.CheckCollision`): while
/// the foreground window covers the collapsed notch, the notch slides away, and
/// it comes back when the cursor is bumped against the very top edge inside the
/// notch's width. Any foreground window counts, not just maximised ones.
///
/// Two deliberate differences from the WPF version:
///
/// * The WPF window was focusable, so clicking the notch made it the foreground
///   window and its `fg == myHwnd` early return is what kept an open panel from
///   hiding. This window is `WS_EX_NOACTIVATE` and is *never* foreground, so
///   the equivalent rule is stated directly: an open panel does not autohide.
/// * The state lives here as a flag rather than being applied by the monitor,
///   because the webview owns the animation. The monitor only reports what it
///   sees; the webview applies it, animates, and calls back with the result.
#[cfg(target_os = "windows")]
mod autohide {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tauri::Emitter;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowRect,
    };

    pub const HIDDEN_EVENT: &str = "notch-autohide";

    static HIDDEN: AtomicBool = AtomicBool::new(false);

    /// Whether the webview is currently showing the notch.
    pub fn is_hidden() -> bool {
        HIDDEN.load(Ordering::Relaxed)
    }

    /// Called once the webview has actually applied (and animated to) the state.
    pub fn set_hidden(hidden: bool) {
        HIDDEN.store(hidden, Ordering::Relaxed);
    }

    /// Desktop, taskbar and the shell's own overlay windows are not "an
    /// application covering the notch" - same list as the WPF original.
    const EXCLUDED_CLASSES: [&str; 5] = [
        "WorkerW",
        "Progman",
        "Shell_TrayWnd",
        "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow",
    ];

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    /// True when the notch should be out of the way.
    fn should_hide() -> bool {
        // No autohide while the panel is open - see the note above.
        if super::mouse_hook::is_open() {
            return false;
        }

        let Some(my) = super::mouse_hook::window_rect() else {
            return false;
        };

        let fg = unsafe { GetForegroundWindow() };
        if fg.0 == 0 || fg == super::mouse_hook::target_hwnd() {
            return false;
        }
        if EXCLUDED_CLASSES.contains(&class_of(fg).as_str()) {
            return false;
        }

        let mut fg_rect = RECT::default();
        if unsafe { GetWindowRect(fg, &mut fg_rect) }.is_err() {
            return false;
        }

        let (left, top, right, bottom) = super::notch_geometry::rect(&my);
        // 2px of slack, as in the original: a window that only just touches the
        // notch should not count.
        let overlaps = fg_rect.left < right + 2
            && fg_rect.right > left - 2
            && fg_rect.top < bottom + 2
            && fg_rect.bottom > top - 2;
        if !overlaps {
            return false;
        }

        let mut cursor = POINT::default();
        if unsafe { GetCursorPos(&mut cursor) }.is_err() {
            return false;
        }

        // Bumping the absolute top edge is the only way back once hidden;
        // while visible, merely being inside the notch also keeps it out.
        let bumping = cursor.y <= my.top && cursor.x >= left && cursor.x <= right;
        let inside = cursor.y >= my.top
            && cursor.y <= my.top + (bottom - top) + 5
            && cursor.x >= left
            && cursor.x <= right;
        let wants_show = if is_hidden() { bumping } else { bumping || inside };

        !wants_show
    }

    pub fn install(app: &tauri::AppHandle) {
        let emitter = app.clone();
        std::thread::spawn(move || {
            let mut reported = false;
            loop {
                std::thread::sleep(Duration::from_millis(200));
                let hide = should_hide();
                if hide != reported {
                    reported = hide;
                    let _ = emitter.emit(HIDDEN_EVENT, hide);
                }
            }
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

/// The webview reporting that it has applied the autohide state. Only needed so
/// the mouse hook knows whether there is a notch to click.
#[tauri::command]
fn set_notch_hidden(hidden: bool) {
    #[cfg(target_os = "windows")]
    autohide::set_hidden(hidden);
    #[cfg(not(target_os = "windows"))]
    let _ = hidden;
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
                autohide::install(app.handle());
                activity::install(app.handle());
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
                notch_geometry::set(true, (w * scale).round() as i32, (h * scale).round() as i32);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_notch_size,
            set_notch_hit,
            set_panel_open,
            set_notch_hidden,
            show_notch_menu,
            power_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
