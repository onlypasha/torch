//! System control and hardware monitoring.
//!
//! Exposes:
//! 1. System actions: Lock workstation, Shutdown, Sleep, Hibernate.
//! 2. Brightness read/write (WMI or fallback).
//! 3. System hardware snapshot: CPU usage (via GetSystemTimes), Memory usage (GlobalMemoryStatusEx),
//!    and Disk capacity usage (GetDiskFreeSpaceExW).

use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Instant;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub mem_used_gb: f64,
    pub mem_total_gb: f64,
    pub disk_percent: f64,
    pub disk_used_gb: f64,
    pub disk_total_gb: f64,
    pub disk_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSettingsState {
    pub brightness: i32,
    pub brightness_supported: bool,
    pub dnd: bool,
    pub dnd_supported: bool,
}

static LAST_CPU_TIMES: Mutex<Option<(u64, u64, Instant)>> = Mutex::new(None);
static BRIGHTNESS_LEVEL: AtomicI32 = AtomicI32::new(50);
/// One panel write at a time. Each write waits for the backlight to report the
/// new level, so two overlapping writes would each read the other's value and
/// one of them would look like a failure.
static BRIGHTNESS_WRITE: Mutex<()> = Mutex::new(());
static DND_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Map a 0–100 slider position onto the display's own raw range.
///
/// Firmware ranges are not always 0–100 (some panels start at 1 or run to 255),
/// so both directions go through these instead of assuming the slider step *is*
/// the raw value.
fn percent_to_raw(percent: i32, min: u32, max: u32) -> u32 {
    if max <= min {
        return min;
    }
    let span = (max - min) as u64;
    let percent = percent.clamp(0, 100) as u64;
    min + ((span * percent + 50) / 100) as u32
}

fn raw_to_percent(raw: u32, min: u32, max: u32) -> i32 {
    if max <= min {
        return 0;
    }
    let span = (max - min) as u64;
    let offset = raw.saturating_sub(min).min(span as u32) as u64;
    ((offset * 100 + span / 2) / span) as i32
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
    };
    use windows::Win32::Foundation::{FILETIME, POINT};
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Shutdown::LockWorkStation;
    use windows::Win32::System::SystemInformation::{
        GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };
    use windows::Win32::System::Power::SetSuspendState;
    use windows::core::PCWSTR;

    fn filetime_to_u64(ft: &FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
    }

    pub fn lock_workstation() -> Result<(), String> {
        unsafe {
            LockWorkStation().map_err(|e| format!("LockWorkStation failed: {e}"))
        }
    }

    pub fn sleep() -> Result<(), String> {
        unsafe {
            // SetSuspendState(bhibernate, bforce, bwakeupeventsdisabled)
            if SetSuspendState(false, false, false).as_bool() {
                Ok(())
            } else {
                Err("SetSuspendState sleep failed".into())
            }
        }
    }

    pub fn hibernate() -> Result<(), String> {
        unsafe {
            if SetSuspendState(true, false, false).as_bool() {
                Ok(())
            } else {
                Err("SetSuspendState hibernate failed".into())
            }
        }
    }

    pub fn shutdown() -> Result<(), String> {
        // Run standard shutdown command without force prompt
        let _ = std::process::Command::new("shutdown")
            .args(["/s", "/t", "0"])
            .spawn();
        Ok(())
    }

    pub fn get_cpu_usage() -> f64 {
        unsafe extern "system" {
            fn GetSystemTimes(
                lpIdleTime: *mut FILETIME,
                lpKernelTime: *mut FILETIME,
                lpUserTime: *mut FILETIME,
            ) -> windows::Win32::Foundation::BOOL;
        }

        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();

        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        if !ok.as_bool() {
            return 0.0;
        }

        let idle_u = filetime_to_u64(&idle);
        let kernel_u = filetime_to_u64(&kernel);
        let user_u = filetime_to_u64(&user);
        let total_u = kernel_u.saturating_add(user_u);

        let mut lock = LAST_CPU_TIMES.lock().unwrap();
        let now = Instant::now();

        if let Some((prev_idle, prev_total, _)) = *lock {
            let delta_idle = idle_u.saturating_sub(prev_idle);
            let delta_total = total_u.saturating_sub(prev_total);

            *lock = Some((idle_u, total_u, now));

            if delta_total > 0 {
                let usage = 1.0 - (delta_idle as f64 / delta_total as f64);
                return (usage * 100.0).clamp(0.0, 100.0);
            }
        } else {
            *lock = Some((idle_u, total_u, now));
        }

        0.0
    }

    pub fn get_memory_info() -> (f64, f64, f64) {
        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

        if unsafe { GlobalMemoryStatusEx(&mut mem).is_ok() } {
            let total = mem.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0);
            let avail = mem.ullAvailPhys as f64 / (1024.0 * 1024.0 * 1024.0);
            let used = (total - avail).max(0.0);
            let pct = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
            (pct.clamp(0.0, 100.0), used, total)
        } else {
            (0.0, 0.0, 0.0)
        }
    }

    pub fn get_disk_info() -> (f64, f64, f64, String) {
        // Check drive C:\ by default
        let drive_wide: Vec<u16> = "C:\\\0".encode_utf16().collect();
        let mut free_bytes_caller = 0u64;
        let mut total_bytes = 0u64;
        let mut total_free_bytes = 0u64;

        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(drive_wide.as_ptr()),
                Some(&mut free_bytes_caller),
                Some(&mut total_bytes),
                Some(&mut total_free_bytes),
            ).is_ok()
        };

        if ok && total_bytes > 0 {
            let total_gb = total_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
            let free_gb = total_free_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
            let used_gb = (total_gb - free_gb).max(0.0);
            let pct = ((used_gb / total_gb) * 100.0).clamp(0.0, 100.0);
            (pct, used_gb, total_gb, "C:".to_string())
        } else {
            (0.0, 0.0, 0.0, "C:".to_string())
        }
    }

    /// The laptop panel exposes brightness through the legacy `\\.\LCD` device,
    /// which is also what Windows' own flyout ends up using on this class of
    /// hardware. DDC/CI (Dxva2) is the more modern route and is tried second,
    /// because plenty of panels answer only one of the two.
    const IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS: u32 = 0x0023_0498;
    const IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS: u32 = 0x0023_049C;
    /// DISPLAYPOLICY_AC / DISPLAYPOLICY_DC from ntddvdeo.h.
    const POLICY_AC: u8 = 0x01;
    const POLICY_DC: u8 = 0x02;

    fn lcd_ioctl(
        code: u32,
        input: Option<&[u8]>,
        output: Option<&mut [u8]>,
    ) -> Result<u32, String> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING,
        };
        use windows::Win32::System::IO::DeviceIoControl;
        use windows::core::w;

        unsafe {
            let handle = CreateFileW(
                w!("\\\\.\\LCD"),
                FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                Default::default(),
                None,
            )
            .map_err(|error| error.message())?;

            let (out_ptr, out_len) = match output {
                Some(buffer) => (buffer.as_mut_ptr().cast(), buffer.len() as u32),
                None => (std::ptr::null_mut(), 0),
            };
            let mut returned = 0u32;
            let result = DeviceIoControl(
                handle,
                code,
                input.map(|bytes| bytes.as_ptr().cast()),
                input.map_or(0, |bytes| bytes.len() as u32),
                if out_len > 0 { Some(out_ptr) } else { None },
                out_len,
                Some(&mut returned),
                None,
            );
            let _ = CloseHandle(handle);
            result.map_err(|error| error.message())?;
            Ok(returned)
        }
    }

    /// `DISPLAY_BRIGHTNESS` is `{ policy, ac, dc }`; the level that matters is
    /// the one for the power source in use.
    fn active_level(raw: [u8; 3]) -> u8 {
        let [policy, ac, dc] = raw;
        if policy & POLICY_DC != 0 {
            dc
        } else if policy & POLICY_AC != 0 {
            ac
        } else {
            ac.max(dc)
        }
    }

    pub(super) fn read_lcd() -> Result<i32, String> {
        let mut raw = [0u8; 3];
        let returned = lcd_ioctl(IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS, None, Some(&mut raw))?;
        if returned < 3 {
            return Err("the LCD device returned a short brightness reply".into());
        }
        Ok(active_level(raw) as i32)
    }

    fn write_lcd(level: i32) -> Result<(), String> {
        let mut raw = [0u8; 3];
        let returned = lcd_ioctl(IOCTL_VIDEO_QUERY_DISPLAY_BRIGHTNESS, None, Some(&mut raw))?;
        if returned < 3 {
            return Err("the LCD device returned a short brightness reply".into());
        }
        let value = level.clamp(0, 100) as u8;
        let mut next = raw;
        if raw[0] & POLICY_AC != 0 {
            next[1] = value;
        }
        if raw[0] & POLICY_DC != 0 {
            next[2] = value;
        }
        if raw[0] & (POLICY_AC | POLICY_DC) == 0 {
            next = [raw[0], value, value];
        }
        lcd_ioctl(IOCTL_VIDEO_SET_DISPLAY_BRIGHTNESS, Some(&next), None)?;
        Ok(())
    }

    /// Run `work` against the primary display's physical monitor (DDC/CI).
    fn with_monitor<T>(
        work: impl FnOnce(&PHYSICAL_MONITOR) -> Result<T, String>,
    ) -> Result<T, String> {
        unsafe {
            let hmonitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            if hmonitor.is_invalid() {
                return Err("no primary monitor".into());
            }
            let mut count = 0u32;
            GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, &mut count)
                .map_err(|error| error.message())?;
            if count == 0 {
                return Err("no physical monitor".into());
            }
            let mut monitors = vec![PHYSICAL_MONITOR::default(); count as usize];
            GetPhysicalMonitorsFromHMONITOR(hmonitor, &mut monitors)
                .map_err(|error| error.message())?;
            let result = work(&monitors[0]);
            let _ = DestroyPhysicalMonitors(&monitors);
            result
        }
    }

    fn read_ddc() -> Result<i32, String> {
        with_monitor(|monitor| unsafe {
            let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
            if GetMonitorBrightness(monitor.hPhysicalMonitor, &mut min, &mut current, &mut max) == 0 {
                return Err("this display does not report its brightness".into());
            }
            Ok(raw_to_percent(current, min, max))
        })
    }

    fn write_ddc(level: i32) -> Result<(), String> {
        with_monitor(|monitor| unsafe {
            let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
            if GetMonitorBrightness(monitor.hPhysicalMonitor, &mut min, &mut current, &mut max) == 0 {
                return Err("this display does not report its brightness".into());
            }
            let target = percent_to_raw(level, min, max);
            if SetMonitorBrightness(monitor.hPhysicalMonitor, target) == 0 {
                return Err("the display refused the brightness change".into());
            }
            Ok(())
        })
    }

    /// The panel's brightness, 0–100, from whichever route answers.
    fn read_panel() -> Result<i32, String> {
        read_lcd().or_else(|lcd| read_ddc().map_err(|ddc| format!("lcd: {lcd}; ddc: {ddc}")))
    }

    /// Write, then wait for the panel to report the new level.
    ///
    /// A backlight answers asynchronously: the very next read still returns the
    /// old value, which is why a one-shot read-back used to look like a failed
    /// write. Six short tries cover the settle time without holding the worker
    /// for long.
    fn write_panel(level: i32) -> Result<(), String> {
        write_lcd(level)
            .or_else(|lcd| write_ddc(level).map_err(|ddc| format!("lcd: {lcd}; ddc: {ddc}")))?;
        for _ in 0..6 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if read_panel().map_or(false, |seen| seen == level) {
                return Ok(());
            }
        }
        Err(format!("the panel did not report {level}% after the change"))
    }

    pub fn read_brightness() -> (i32, bool) {
        match read_panel() {
            Ok(level) => {
                BRIGHTNESS_LEVEL.store(level, Ordering::Relaxed);
                (level, true)
            }
            // A display with no brightness route at all: the cached number is
            // reported as unsupported rather than as the screen's real level.
            Err(_) => (BRIGHTNESS_LEVEL.load(Ordering::Relaxed), false),
        }
    }

    pub fn set_brightness(value: i32) -> Result<(), String> {
        let _writer = BRIGHTNESS_WRITE
            .lock()
            .map_err(|_| "the brightness writer was poisoned".to_string())?;
        let wanted = value.clamp(0, 100);
        write_panel(wanted)?;
        BRIGHTNESS_LEVEL.store(wanted, Ordering::Relaxed);
        Ok(())
    }
}

pub fn get_stats() -> SystemStats {
    #[cfg(target_os = "windows")]
    {
        let cpu = win::get_cpu_usage();
        let (mem_pct, mem_used, mem_total) = win::get_memory_info();
        let (disk_pct, disk_used, disk_total, disk_lbl) = win::get_disk_info();
        SystemStats {
            cpu_percent: cpu,
            mem_percent: mem_pct,
            mem_used_gb: mem_used,
            mem_total_gb: mem_total,
            disk_percent: disk_pct,
            disk_used_gb: disk_used,
            disk_total_gb: disk_total,
            disk_label: disk_lbl,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        SystemStats {
            cpu_percent: 15.0,
            mem_percent: 45.0,
            mem_used_gb: 7.2,
            mem_total_gb: 16.0,
            disk_percent: 50.0,
            disk_used_gb: 250.0,
            disk_total_gb: 500.0,
            disk_label: "Disk".into(),
        }
    }
}

pub fn get_quick_settings() -> QuickSettingsState {
    let (bri, sup) = {
        #[cfg(target_os = "windows")]
        { win::read_brightness() }
        #[cfg(not(target_os = "windows"))]
        { (70, true) }
    };
    QuickSettingsState {
        brightness: bri,
        brightness_supported: sup,
        dnd: DND_ACTIVE.load(Ordering::Relaxed),
        dnd_supported: true,
    }
}

pub fn set_brightness(val: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::set_brightness(val);
    #[cfg(not(target_os = "windows"))]
    {
        BRIGHTNESS_LEVEL.store(val.clamp(0, 100), Ordering::Relaxed);
        Ok(())
    }
}

/// Fast, side-effect-free brightness sample for the HUD watcher.
///
/// Deliberately the LCD route only: it takes a millisecond, while a DDC/CI read
/// can stall for tens of milliseconds and should not be put on a 120ms timer.
/// A panel that only answers DDC simply gets no Fn-key HUD, rather than a
/// watcher that hammers the monitor bus.
pub fn watch_brightness() -> Option<i32> {
    #[cfg(target_os = "windows")]
    {
        win::read_lcd().ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

pub fn toggle_dnd() -> bool {
    let current = DND_ACTIVE.load(Ordering::Relaxed);
    let next = !current;
    DND_ACTIVE.store(next, Ordering::Relaxed);
    next
}

pub fn action_lock() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::lock_workstation();
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

pub fn action_sleep() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::sleep();
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

pub fn action_hibernate() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::hibernate();
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

pub fn action_shutdown() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::shutdown();
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

#[cfg(test)]
mod brightness_tests {
    use super::{percent_to_raw, raw_to_percent};

    #[test]
    fn a_slider_percent_maps_onto_the_monitor_range() {
        assert_eq!(percent_to_raw(0, 0, 100), 0);
        assert_eq!(percent_to_raw(50, 0, 100), 50);
        assert_eq!(percent_to_raw(100, 0, 100), 100);
        // Ranges that are not 0-100 are common on DDC/CI panels.
        assert_eq!(percent_to_raw(50, 20, 220), 120);
        assert_eq!(percent_to_raw(100, 20, 220), 220);
        assert_eq!(percent_to_raw(-5, 20, 220), 20);
        assert_eq!(percent_to_raw(140, 20, 220), 220);
    }

    #[test]
    fn a_raw_value_reads_back_as_a_whole_percent() {
        assert_eq!(raw_to_percent(120, 20, 220), 50);
        assert_eq!(raw_to_percent(220, 20, 220), 100);
        assert_eq!(raw_to_percent(20, 20, 220), 0);
        assert_eq!(raw_to_percent(2, 20, 220), 0);
        assert_eq!(raw_to_percent(999, 20, 220), 100);
    }

    #[test]
    fn every_slider_step_survives_the_round_trip() {
        for percent in 0..=100 {
            let raw = percent_to_raw(percent, 1, 101);
            assert_eq!(raw_to_percent(raw, 1, 101), percent);
        }
    }

    #[test]
    fn a_degenerate_range_does_not_divide_by_zero() {
        assert_eq!(percent_to_raw(50, 7, 7), 7);
        assert_eq!(raw_to_percent(7, 7, 7), 0);
    }

    #[test]
    #[ignore = "manual Windows probe: moves the real panel brightness one step and restores it"]
    fn brightness_windows_probe() {
        let before = super::get_quick_settings();
        println!(
            "before={}% supported={}",
            before.brightness, before.brightness_supported
        );
        assert!(
            before.brightness_supported,
            "this display does not expose a controllable backlight"
        );

        let step = if before.brightness < 100 {
            before.brightness + 1
        } else {
            before.brightness - 1
        };
        let wrote = super::set_brightness(step);
        let seen = super::get_quick_settings();
        println!("wrote={step}% read={}%", seen.brightness);

        // Put the panel back before asserting, so a failure never leaves the
        // screen at the probe's value.
        let restored = super::set_brightness(before.brightness);
        let after = super::get_quick_settings();
        println!("restored={}%", after.brightness);

        wrote.expect("the panel should accept a one-step change");
        assert_eq!(seen.brightness, step, "the panel did not report the new level");
        restored.expect("restore");
        assert_eq!(after.brightness, before.brightness);
    }
}
