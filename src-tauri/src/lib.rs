//! Windows notch overlay - foundation layer.
//!
//! This module owns everything native: window styling, positioning, hit area,
//! the click-outside hook and the size command. UI behaviour lives in the webview.
//!
//! A note on the window size: resizing the native window while its WebView2
//! surface is re-created makes the notch blink for a couple of frames (measured
//! on Windows 11, ~35 ms of blank). So the window keeps the *expanded* size for
//! its whole life and the collapsed state is expressed as a window region
//! instead: pixels outside the region are click-through, and changing the region
//! never touches the webview surface.
//!
//! WebView2 also delivers mouse events over fully transparent pixels, so an
//! unclipped window would quietly swallow desktop clicks over the whole
//! top-centre block. The region is what prevents that.

use tauri::{Manager, WebviewWindow};

/// Sizes are given in logical pixels; the physical conversion happens here so
/// the webview never has to think about DPI.
const INITIAL_WIDTH: f64 = 400.0;
const INITIAL_HEIGHT: f64 = 180.0;

/// Startup hit area: must match COLLAPSED in src/App.tsx. The frontend re-asserts
/// the same values as soon as it mounts, this is only so the window does not
/// swallow clicks in the first few frames after launch.
const INITIAL_NOTCH: (f64, f64, f64, f64) = (180.0, 32.0, 22.0, 20.0);

#[cfg(target_os = "windows")]
mod win {
    use tauri::WebviewWindow;

    pub use platform_impl::*;

    #[cfg(target_os = "windows")]
    mod platform_impl {
        use super::*;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowLongW, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowLongW,
            SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
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
    }

    #[cfg(not(target_os = "windows"))]
    mod platform_impl {
        use super::*;
        pub fn apply_styles(_window: &WebviewWindow) {}
    }

    /// The hit area. Outside it the window is transparent to both painting and
    /// the mouse, which is how the collapsed notch stops eating desktop clicks.
    pub mod region {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, HGDIOBJ, HRGN, RGN_OR,
            SetWindowRgn,
        };

        /// Full window: used while the panel is open or animating, so nothing
        /// the notch paints can ever be clipped.
        pub fn clear(hwnd: HWND) {
            unsafe {
                // A null region restores the default rectangular hit area.
                let _ = SetWindowRgn(hwnd, HRGN::default(), true);
            }
        }

        /// The notch silhouette - square top corners (it hangs off the screen
        /// edge), rounded bottom corners - grown downwards by `margin` so the
        /// drop shadow still has room to render.
        pub fn notch(
            hwnd: HWND,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            radius: i32,
            margin: i32,
        ) -> windows::core::Result<()> {
            unsafe {
                let straight = (h - radius).max(1);
                let upper = CreateRectRgn(x, y, x + w, y + straight);
                let lower = CreateRoundRectRgn(
                    x,
                    y + straight - radius,
                    x + w + 1,
                    y + h + margin + 1,
                    radius * 2,
                    radius * 2,
                );

                if upper.is_invalid() || lower.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(upper.0));
                    let _ = DeleteObject(HGDIOBJ(lower.0));
                    return Err(windows::core::Error::from_win32());
                }

                let _ = CombineRgn(upper, upper, lower, RGN_OR);
                let _ = DeleteObject(HGDIOBJ(lower.0));

                // SetWindowRgn takes ownership on success, so only free it if
                // the call failed.
                let applied = SetWindowRgn(hwnd, upper, true);
                if applied == 0 {
                    let _ = DeleteObject(HGDIOBJ(upper.0));
                    return Err(windows::core::Error::from_win32());
                }
                Ok(())
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

/// The hit area of the window. `width <= 0` means "whole window", which is what
/// the panel needs while it is open or mid-animation. Values are logical pixels.
#[tauri::command]
fn set_hit_region(
    window: WebviewWindow,
    width: f64,
    height: f64,
    radius: f64,
    margin: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = win::raw(&window).ok_or("no hwnd")?;

        if width <= 0.0 || height <= 0.0 {
            win::region::clear(hwnd);
            return Ok(());
        }

        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let inner = window.inner_size().map_err(|e| e.to_string())?;

        // The notch is centred in the window, matching `left-1/2 -translate-x-1/2`.
        let w = (width * scale).round() as i32;
        let x = (inner.width as i32 - w) / 2;

        return win::region::notch(
            hwnd,
            x,
            0,
            w,
            (height * scale).round() as i32,
            (radius * scale).round() as i32,
            (margin * scale).round() as i32,
        )
        .map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, width, height, radius, margin);
        Ok(())
    }
}

/// The hook needs to know whether the panel is open, because the click-outside
/// callback on the hook thread only has the atomics, not the webview.
#[tauri::command]
fn set_panel_open(open: bool) {
    #[cfg(target_os = "windows")]
    click_outside::set_panel_open(open);
    #[cfg(not(target_os = "windows"))]
    let _ = open;
}

// The window is WS_EX_NOACTIVATE and (with the collapsed hit region in place)
// does not even see the clicks that land on other applications, so it cannot
// notice an outside click by itself. A low-level mouse hook is therefore the
// only reliable way to collapse the panel when the user clicks away.
#[cfg(target_os = "windows")]
mod click_outside {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::mpsc::Sender;

    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, GetWindowRect, HHOOK, MSG, MSLLHOOKSTRUCT,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONDOWN,
    };

    pub const EVENT: &str = "notch-click-outside";

    static NOTIFY: OnceLock<Sender<()>> = OnceLock::new();
    static TARGET_HWND: AtomicIsize = AtomicIsize::new(0);
    static OPEN: AtomicBool = AtomicBool::new(false);

    pub fn set_panel_open(open: bool) {
        OPEN.store(open, Ordering::Relaxed);
    }

    /// Runs on the hook thread, so it must stay allocation- and IPC-free.
    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && wparam.0 as u32 == WM_LBUTTONDOWN && OPEN.load(Ordering::Relaxed) {
            let raw = TARGET_HWND.load(Ordering::Relaxed);
            if raw != 0 {
                let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                let mut rect = RECT::default();
                if unsafe { GetWindowRect(HWND(raw), &mut rect) }.is_ok() {
                    let POINT { x, y } = info.pt;
                    let inside =
                        x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
                    if !inside {
                        // Hand the work to a dedicated thread: never block here.
                        if let Some(tx) = NOTIFY.get() {
                            let _ = tx.send(());
                        }
                    }
                }
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

        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let _ = NOTIFY.set(tx);

        let emitter = app.clone();
        std::thread::spawn(move || {
            for _ in rx {
                let _ = emitter.emit(EVENT, ());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;

            #[cfg(target_os = "windows")]
            {
                win::apply_styles(&window);
                click_outside::install(app.handle());
            }

            // Place it top-centre immediately so the first frames are already
            // in the right spot instead of flashing at the default position.
            set_notch_size(window.clone(), INITIAL_WIDTH, INITIAL_HEIGHT)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            let (w, h, radius, margin) = INITIAL_NOTCH;
            set_hit_region(window.clone(), w, h, radius, margin)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_notch_size,
            set_hit_region,
            set_panel_open
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
