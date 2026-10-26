//! Diagnostic probe: what does this keyboard actually send?
//!
//! The notch HUD needs to intercept the volume keys and the Fn brightness
//! keys. Volume keys are ordinary virtual keys (`VK_VOLUME_*`), which a
//! low-level keyboard hook sees. Brightness has no standard virtual key on
//! Windows, and on ASUS laptops the Fn row is often handled by the ATK/ASUS
//! service outside the normal keyboard path, so the only honest way to know
//! what reaches us is to listen while the user presses the keys.
//!
//! Run with:
//!
//! ```text
//! cargo run --example keyprobe -- 120
//! ```
//!
//! Every keyboard event the low-level hook sees is logged with its virtual key,
//! scan code and flags. Separately, a hidden message-only window receives raw
//! HID input, which is where a consumer-page brightness usage (`0x006F` /
//! `0x0070`) would show up even though it has no virtual key.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::{
    GetRawInputData, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT,
    RIM_TYPEHID, RIM_TYPEKEYBOARD, RegisterRawInputDevices,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
    HHOOK, HWND_MESSAGE, KBDLLHOOKSTRUCT, MSG, RegisterClassW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP, WNDCLASSW,
};
use windows::core::w;

static LOG: OnceLock<Mutex<File>> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();

fn log(line: &str) {
    let elapsed = START.get().map_or(0, |start| start.elapsed().as_millis());
    let stamped = format!("[{elapsed:>7}ms] {line}");
    println!("{stamped}");
    if let Some(file) = LOG.get() {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{stamped}");
            let _ = file.flush();
        }
    }
}

fn key_name(vk: u32) -> &'static str {
    match vk {
        0xAD => "VK_VOLUME_MUTE",
        0xAE => "VK_VOLUME_DOWN",
        0xAF => "VK_VOLUME_UP",
        0xB0 => "VK_MEDIA_NEXT_TRACK",
        0xB1 => "VK_MEDIA_PREV_TRACK",
        0xB2 => "VK_MEDIA_STOP",
        0xB3 => "VK_MEDIA_PLAY_PAUSE",
        0x2E => "VK_DELETE",
        0x5B => "VK_LWIN",
        0x5C => "VK_RWIN",
        0xA0 => "VK_LSHIFT",
        0xA1 => "VK_RSHIFT",
        _ => "",
    }
}

/// Runs on the hook thread; must be quick and allocation-light. A diagnostic
/// may write a file, but the shipped hook will only send an event.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        if matches!(message, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP) {
            if let Some(info) = unsafe { (lparam.0 as *const KBDLLHOOKSTRUCT).as_ref() } {
                let phase = if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN) {
                    "down"
                } else {
                    "up  "
                };
                log(&format!(
                    "key {phase} vk=0x{:02X} ({}) scan=0x{:02X} flags=0x{:X} time={} extra=0x{:X}",
                    info.vkCode,
                    key_name(info.vkCode),
                    info.scanCode,
                    info.flags.0,
                    info.time,
                    info.dwExtraInfo,
                ));
                for scan in [0x6F, 0x70, 0x6E, 0x71, 0x72, 0x73, 0x74] {
                    if info.scanCode == scan {
                        log(&format!("     ^ scan 0x{scan:02X} is a brightness candidate"));
                    }
                }
            }
        }
    }
    unsafe { CallNextHookEx(HHOOK::default(), code, wparam, lparam) }
}

unsafe extern "system" fn raw_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        let mut size = 0u32;
        let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
        unsafe {
            GetRawInputData(
                windows::Win32::UI::Input::HRAWINPUT(lparam.0),
                RID_INPUT,
                None,
                &mut size,
                header,
            )
        };
        if size > 0 {
            let mut buffer = vec![0u8; size as usize];
            let read = unsafe {
                GetRawInputData(
                    windows::Win32::UI::Input::HRAWINPUT(lparam.0),
                    RID_INPUT,
                    Some(buffer.as_mut_ptr().cast()),
                    &mut size,
                    header,
                )
            };
            if read > 0 {
                let raw = unsafe { &*(buffer.as_ptr() as *const RAWINPUT) };
                match raw.header.dwType {
                    value if value == RIM_TYPEKEYBOARD.0 => {
                        let keyboard = unsafe { raw.data.keyboard };
                        log(&format!(
                            "raw keyboard vk=0x{:02X} make=0x{:02X} flags=0x{:X} message=0x{:X} extra=0x{:X}",
                            keyboard.VKey, keyboard.MakeCode, keyboard.Flags, keyboard.Message,
                            keyboard.ExtraInformation,
                        ));
                    }
                    value if value == RIM_TYPEHID.0 => {
                        let hid = unsafe { raw.data.hid };
                        let count = hid.dwCount as usize * hid.dwSizeHid as usize;
                        let bytes = unsafe {
                            std::slice::from_raw_parts(hid.bRawData.as_ptr(), count.min(64))
                        };
                        let hex: Vec<String> =
                            bytes.iter().map(|byte| format!("{byte:02X}")).collect();
                        log(&format!(
                            "raw hid device={:?} count={} size={} data=[{}]",
                            raw.header.hDevice,
                            hid.dwCount,
                            hid.dwSizeHid,
                            hex.join(" "),
                        ));
                    }
                    other => log(&format!("raw type={other}")),
                }
            }
        }
        // WM_INPUT must be answered through DefWindowProc so the system can
        // clean up its copy of the report.
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn raw_input_thread() {
    unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(error) => {
                log(&format!("raw input: no module handle: {error}"));
                return;
            }
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(raw_proc),
            hInstance: HINSTANCE(module.0),
            lpszClassName: w!("NotchKeyProbeRaw"),
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            log("raw input: RegisterClassW failed");
            return;
        }
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("NotchKeyProbeRaw"),
            w!("notch key probe"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            HINSTANCE(module.0),
            None,
        ) {
            hwnd if hwnd.0 != 0 => hwnd,
            _ => {
                log("raw input: CreateWindowExW failed");
                return;
            }
        };
        let devices = [
            RAWINPUTDEVICE {
                usUsagePage: 0x01,
                usUsage: 0x06,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
            RAWINPUTDEVICE {
                usUsagePage: 0x0C,
                usUsage: 0x01,
                dwFlags: RIDEV_INPUTSINK,
                hwndTarget: hwnd,
            },
        ];
        match RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32) {
            Ok(()) => log("raw input: registered keyboard + consumer collections"),
            Err(error) => log(&format!("raw input: registration failed: {error}")),
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse::<u64>().ok())
        .unwrap_or(120);
    let path = std::env::temp_dir().join("notch-keyprobe.log");
    START.set(Instant::now()).ok();
    match OpenOptions::new().create(true).write(true).truncate(true).open(&path) {
        Ok(file) => {
            let _ = LOG.set(Mutex::new(file));
        }
        Err(error) => eprintln!("could not open {}: {error}", path.display()),
    }

    log(&format!(
        "probe starts; log at {}. Press volume up/down/mute and Fn brightness up/down now.",
        path.display()
    ));

    std::thread::spawn(raw_input_thread);

    std::thread::spawn(move || unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(error) => {
                log(&format!("keyboard hook: no module handle: {error}"));
                return;
            }
        };
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE(module.0), 0)
        {
            Ok(hook) => hook,
            Err(error) => {
                log(&format!("keyboard hook: install failed: {error}"));
                return;
            }
        };
        log("keyboard hook installed");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    });

    std::thread::sleep(Duration::from_secs(seconds));
    log("probe finished");
}
