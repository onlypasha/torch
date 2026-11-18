//! A small OLE landing surface for the click-through collapsed notch.
//! It is hidden except while a held-button drag approaches the notch. Merely
//! moving/selecting text does not open Tray: IDropTarget validates CF_HDROP.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::Emitter;
use windows::{
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, POINTL, WPARAM},
        Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH},
        System::{
            Com::{DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL},
            LibraryLoader::GetModuleHandleW,
            Ole::{
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget,
                IDropTarget_Impl, OleInitialize, OleUninitialize, RegisterDragDrop,
                ReleaseStgMedium, RevokeDragDrop,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON},
            Shell::{DragQueryFileW, HDROP},
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
                HWND_TOPMOST, LWA_ALPHA, MSG, PM_REMOVE, PeekMessageW, RegisterClassW, SW_HIDE,
                SWP_NOACTIVATE, SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetWindowPos,
                ShowWindow, TranslateMessage, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
            },
        },
    },
    core::{implement, w},
};

type Rect = (i32, i32, i32, i32);
#[derive(Default)]
struct DragIntent {
    origin: Option<(i32, i32)>,
    cancelled: bool,
}
impl DragIntent {
    fn update(&mut self, down: bool, escape: bool, point: (i32, i32)) -> bool {
        if !down {
            *self = Self::default();
            return false;
        }
        if escape {
            self.cancelled = true;
        }
        let origin = *self.origin.get_or_insert(point);
        !self.cancelled && (point.0.abs_diff(origin.0) >= 4 || point.1.abs_diff(origin.1) >= 4)
    }
}
fn near((x, y): (i32, i32), (left, top, right, bottom): Rect) -> bool {
    x >= left - 24 && x < right + 24 && y >= top - 24 && y < bottom + 24
}
fn file_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
        ..Default::default()
    }
}
fn supports_files(data: Option<&IDataObject>) -> bool {
    data.is_some_and(|data| unsafe { data.QueryGetData(&file_format()).is_ok() })
}
/// Publish standard file paths explicitly: Shell ID-list objects alone do not
/// necessarily render CF_HDROP for ordinary Windows drop targets.
pub(crate) fn set_file_paths(data: &IDataObject, paths: &[String]) -> windows::core::Result<()> {
    use windows::Win32::{
        Foundation::GlobalFree,
        System::{
            Com::{STGMEDIUM, STGMEDIUM_0},
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
        UI::Shell::DROPFILES,
    };
    let names: Vec<u16> = paths
        .iter()
        .flat_map(|path| path.encode_utf16().chain(Some(0)))
        .chain(Some(0))
        .collect();
    let header = std::mem::size_of::<DROPFILES>();
    let mut bytes = vec![0u8; header + names.len() * 2];
    bytes[..4].copy_from_slice(&(header as u32).to_le_bytes());
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
    for (index, ch) in names.iter().enumerate() {
        bytes[header + index * 2..header + index * 2 + 2].copy_from_slice(&ch.to_le_bytes());
    }
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let ptr = GlobalLock(memory);
        if ptr.is_null() {
            let error = windows::core::Error::from_win32();
            let _ = GlobalFree(memory);
            return Err(error);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(memory);
        let medium = STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: memory },
            ..Default::default()
        };
        if let Err(error) = data.SetData(&file_format(), &medium, true) {
            let _ = GlobalFree(memory);
            return Err(error);
        }
    }
    Ok(())
}
fn paths(data: &IDataObject) -> windows::core::Result<Vec<String>> {
    let mut medium = unsafe { data.GetData(&file_format())? };
    let result = (|| {
        if medium.tymed != TYMED_HGLOBAL.0 as u32 {
            return Err(windows::core::Error::from_win32());
        }
        let drop = HDROP(unsafe { medium.u.hGlobal.0 } as isize);
        let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
        if count == 0 || count > 128 {
            return Err(windows::core::Error::from_win32());
        }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let len = unsafe { DragQueryFileW(drop, index, None) } as usize;
            if len == 0 || len > 32767 {
                return Err(windows::core::Error::from_win32());
            }
            let mut text = vec![0; len + 1];
            unsafe {
                DragQueryFileW(drop, index, Some(&mut text));
            }
            paths.push(String::from_utf16_lossy(&text[..len]));
        }
        Ok(paths)
    })();
    unsafe {
        ReleaseStgMedium(&mut medium);
    }
    result
}

enum Signal {
    Enter,
    Leave,
    Drop(Vec<String>),
}
#[implement(IDropTarget)]
struct LandingTarget {
    accepted: AtomicBool,
    engaged: Arc<AtomicBool>,
    send: Arc<dyn Fn(Signal) -> bool + Send + Sync>,
}
impl IDropTarget_Impl for LandingTarget {
    fn DragEnter(
        &self,
        data: Option<&IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if effect.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        let copy_allowed = unsafe { (*effect).0 & DROPEFFECT_COPY.0 != 0 };
        let valid = copy_allowed && supports_files(data);
        self.accepted.store(valid, Ordering::Relaxed);
        unsafe {
            *effect = if valid {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if valid {
            self.engaged.store(true, Ordering::Relaxed);
            (self.send)(Signal::Enter);
        }
        Ok(())
    }
    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !effect.is_null() {
            unsafe {
                *effect = if self.accepted.load(Ordering::Relaxed)
                    && (*effect).0 & DROPEFFECT_COPY.0 != 0
                {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
        }
        Ok(())
    }
    fn DragLeave(&self) -> windows::core::Result<()> {
        if self.accepted.swap(false, Ordering::Relaxed) {
            (self.send)(Signal::Leave);
        }
        Ok(())
    }
    fn Drop(
        &self,
        data: Option<&IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let allowed = !effect.is_null() && unsafe { (*effect).0 & DROPEFFECT_COPY.0 != 0 };
        if !effect.is_null() {
            unsafe {
                *effect = DROPEFFECT_NONE;
            }
        }
        if allowed && self.accepted.swap(false, Ordering::Relaxed) {
            if let Some(data) = data {
                if let Ok(paths) = paths(data) {
                    if (self.send)(Signal::Drop(paths)) {
                        unsafe {
                            *effect = DROPEFFECT_COPY;
                        }
                    }
                }
            }
        }
        (self.send)(Signal::Leave);
        Ok(())
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}
pub fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("tray-drop-landing".into())
        .spawn(move || {
            if let Err(error) = run(app) {
                eprintln!("Tray drag detection unavailable: {error}");
            }
        });
}
fn run(app: tauri::AppHandle) -> windows::core::Result<()> {
    unsafe {
        OleInitialize(None)?;
    }
    struct OleGuard;
    impl Drop for OleGuard {
        fn drop(&mut self) {
            unsafe {
                OleUninitialize();
            }
        }
    }
    let _ole = OleGuard;
    let instance = HINSTANCE(unsafe { GetModuleHandleW(None)? }.0);
    let class = w!("NotchTrayDropLanding");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: class,
        hbrBackground: HBRUSH(unsafe { GetStockObject(BLACK_BRUSH) }.0),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err(windows::core::Error::from_win32());
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class,
            w!("Notch Tray drop target"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            instance,
            None,
        )
    };
    if hwnd.0 == 0 {
        return Err(windows::core::Error::from_win32());
    }
    struct WindowGuard(HWND);
    impl Drop for WindowGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = RevokeDragDrop(self.0);
                let _ = DestroyWindow(self.0);
            }
        }
    }
    let _window = WindowGuard(hwnd);
    // Alpha zero is not hit-testable. Alpha one is effectively invisible but
    // lets OLE address the landing surface while the main window passes through.
    unsafe {
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA)?;
    }
    let engaged = Arc::new(AtomicBool::new(false));
    let target: IDropTarget = LandingTarget {
        accepted: AtomicBool::new(false),
        engaged: engaged.clone(),
        send: Arc::new(move |signal| match signal {
            Signal::Enter => app.emit("tray-drag-hover", true).is_ok(),
            Signal::Leave => app.emit("tray-drag-hover", false).is_ok(),
            Signal::Drop(paths) => app.emit("tray-native-drop", paths).is_ok(),
        }),
    }
    .into();
    unsafe {
        RegisterDragDrop(hwnd, &target)?;
    }
    let mut intent = DragIntent::default();
    let mut visible = false;
    let mut landing: Option<Rect> = None;
    let mut shown_rect: Option<Rect> = None;
    let mut was_down = false;
    let mut released_at: Option<std::time::Instant> = None;
    loop {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
        let escape = unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } < 0;
        if down {
            released_at = None;
        } else if was_down {
            released_at = Some(std::time::Instant::now());
        }
        was_down = down;
        let mut cursor = POINT::default();
        let located = unsafe { GetCursorPos(&mut cursor) }.is_ok();
        let dragging = located && intent.update(down, escape, (cursor.x, cursor.y));
        if !down || escape {
            engaged.store(false, Ordering::Relaxed);
            landing = None;
        }
        if !engaged.load(Ordering::Relaxed) {
            landing = if crate::notch_geometry::is_collapsed() {
                crate::mouse_hook::window_rect().map(|rect| crate::notch_geometry::rect(&rect))
            } else {
                None
            };
        }
        let wants = dragging && landing.is_some_and(|rect| near((cursor.x, cursor.y), rect));
        if wants {
            if let Some((left, top, right, bottom)) = landing {
                // Never capture the expanded panel: this surface keeps its
                // original collapsed bounds for this entire drag gesture.
                if !visible || shown_rect != landing {
                    unsafe {
                        SetWindowPos(
                            hwnd,
                            HWND_TOPMOST,
                            left,
                            top,
                            right - left,
                            bottom - top,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        )?;
                    }
                }
                shown_rect = landing;
                visible = true;
            }
        } else if visible
            && (escape || !released_at.is_some_and(|at| at.elapsed() < Duration::from_millis(120)))
        {
            // The source's OLE Drop RPC can arrive just after the physical
            // button-up. Give that message a short chance to reach its target.
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            visible = false;
            shown_rect = None;
        }
        std::thread::sleep(Duration::from_millis(if down { 16 } else { 40 }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_drag_distance_and_resets_after_release_or_escape() {
        let mut intent = DragIntent::default();
        assert!(!intent.update(false, false, (20, 20)));
        assert!(!intent.update(true, false, (20, 20)));
        assert!(!intent.update(true, false, (22, 22)));
        assert!(intent.update(true, false, (24, 20)));
        assert!(!intent.update(true, true, (25, 20)));
        assert!(!intent.update(true, false, (50, 20)));
        assert!(!intent.update(false, false, (50, 20)));
        assert!(!intent.update(true, false, (50, 20)));
        assert!(intent.update(true, false, (55, 20)));
    }
    #[test]
    fn landing_uses_screen_coordinates_and_small_approach_margin() {
        let rect = (-1100, -800, -900, -766);
        assert!(near((-1000, -790), rect));
        assert!(near((-1120, -800), rect));
        assert!(!near((-1140, -790), rect));
        assert!(!near((-1000, -600), rect));
        assert!(!supports_files(None));
    }

    #[test]
    fn shell_file_hover_opens_once_and_drop_extracts_paths_without_copying() {
        use std::sync::Mutex;
        use windows::Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{Common::ITEMIDLIST, SHCreateDataObject, SHParseDisplayName},
        };
        unsafe {
            OleInitialize(None).unwrap();
        }
        struct Ole;
        impl Drop for Ole {
            fn drop(&mut self) {
                unsafe {
                    OleUninitialize();
                }
            }
        }
        let _ole = Ole;
        let dir = std::env::temp_dir().join(format!("notch-landing-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("original.txt");
        std::fs::write(&file, "unchanged source").unwrap();
        let path: Vec<u16> = file
            .to_str()
            .unwrap()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        unsafe {
            SHParseDisplayName(
                windows::core::PCWSTR(path.as_ptr()),
                None,
                &mut pidl,
                0,
                None,
            )
            .unwrap();
        }
        let object: IDataObject =
            unsafe { SHCreateDataObject(None, Some(&[pidl as *const _]), None).unwrap() };
        set_file_paths(&object, &[file.to_string_lossy().into_owned()]).unwrap();
        unsafe {
            CoTaskMemFree(Some(pidl as _));
        }
        let signals = Arc::new(Mutex::new(Vec::new()));
        let received = signals.clone();
        let target = LandingTarget {
            accepted: AtomicBool::new(false),
            engaged: Arc::new(AtomicBool::new(false)),
            send: Arc::new(move |signal| {
                received.lock().unwrap().push(signal);
                true
            }),
        };
        let point = POINTL::default();
        let keys = MODIFIERKEYS_FLAGS(0);
        let mut effect = DROPEFFECT_COPY;
        target.DragEnter(None, keys, &point, &mut effect).unwrap();
        assert_eq!(effect, DROPEFFECT_NONE);
        assert!(signals.lock().unwrap().is_empty());
        effect = DROPEFFECT_COPY;
        target
            .DragEnter(Some(&object), keys, &point, &mut effect)
            .unwrap();
        assert_eq!(effect, DROPEFFECT_COPY);
        target.DragOver(keys, &point, &mut effect).unwrap();
        assert_eq!(signals.lock().unwrap().len(), 1);
        assert!(matches!(signals.lock().unwrap()[0], Signal::Enter));
        let extracted = paths(&object);
        assert!(
            extracted.is_ok(),
            "Shell path extraction failed: {extracted:?}"
        );
        target
            .Drop(Some(&object), keys, &point, &mut effect)
            .unwrap();
        assert_eq!(effect, DROPEFFECT_COPY);
        let signals = signals.lock().unwrap();
        match &signals[1] {
            Signal::Drop(paths) => assert_eq!(
                std::path::Path::new(&paths[0]).canonicalize().unwrap(),
                file.canonicalize().unwrap()
            ),
            _ => panic!("expected file drop"),
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "unchanged source");
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
