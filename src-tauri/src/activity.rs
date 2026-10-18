//! Activity indicators: what the notch shows *instead of* the clock when the
//! machine changes state.
//!
//! Four watchers run on their own threads and each polls one Windows API. The
//! period is set by how quickly that change is worth showing, not by what the
//! call costs - all four together measure well under a millisecond per second
//! of runtime - so the charger is checked every second, the networks and the USB
//! tree every two, and Bluetooth every four.
//!
//! The watchers only *notice* and emit. Everything the user sees - the queue,
//! the three-second dwell, the cross-fade with the clock - lives in the webview,
//! which is also the only side that knows whether the panel happens to be open
//! and the indicator therefore has to wait.
//!
//! Two rules are baked into every watcher:
//!
//! * The first successful poll only seeds a baseline. A machine that boots with
//!   the charger in, a network up and three USB devices attached must not queue
//!   half a dozen indicators the moment the app starts.
//! * Nothing is emitted for a state that merely *ends*, except where the user
//!   asked for it (the charger and USB). Wi-Fi, Ethernet and Bluetooth only
//!   report coming up.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::size_of;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    DIGCF_PRESENT, GUID_DEVCLASS_USB, HDEVINFO, SP_DEVINFO_DATA, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDevicePropertyW,
};
use windows::Win32::Devices::Properties::{
    DEVPKEY_Device_BusReportedDeviceDesc, DEVPKEY_Device_DeviceDesc, DEVPKEY_Device_FriendlyName,
    DEVPROP_TYPE_STRING, DEVPROPKEY, DEVPROPTYPE,
};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::NetworkManagement::WiFi::{
    WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle, WlanEnumInterfaces,
    WlanFreeMemory, WlanOpenHandle, WlanQueryInterface, wlan_interface_state_connected,
    wlan_intf_opcode_current_connection,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::core::PCWSTR;

/// Event the webview listens on. The payload is `{ kind, detail }`.
pub const ACTIVITY_EVENT: &str = "notch-activity";

const POWER_PERIOD: Duration = Duration::from_millis(1000);
const NETWORK_PERIOD: Duration = Duration::from_millis(2000);
const USB_PERIOD: Duration = Duration::from_millis(1500);
const BLUETOOTH_PERIOD: Duration = Duration::from_millis(4000);

/// How long the USB watcher waits for the device tree to finish growing before
/// it decides what was plugged in. One physical device enumerates as several
/// nodes - a composite parent plus its functions - and they do not always land
/// in the same enumeration pass.
const USB_SETTLE: Duration = Duration::from_millis(700);

/// One indicator. `kind` picks the icon and the wording, `detail` is the part
/// that comes from the machine: the battery percentage, the SSID, a device name.
#[derive(Clone, serde::Serialize)]
pub struct Activity {
    pub kind: &'static str,
    pub detail: String,
}

pub fn install(app: &AppHandle) {
    spawn(app, "activity-power", watch_power);
    spawn(app, "activity-network", watch_network);
    spawn(app, "activity-usb", watch_usb);
    spawn(app, "activity-bluetooth", watch_bluetooth);
}

fn spawn(app: &AppHandle, name: &str, watcher: fn(AppHandle)) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || watcher(app));
    if let Err(err) = spawned {
        // The notch simply will not report this source; not fatal.
        eprintln!("{name} watcher failed to start: {err}");
    }
}

fn emit(app: &AppHandle, kind: &'static str, detail: impl Into<String>) {
    let payload = Activity {
        kind,
        detail: detail.into(),
    };
    if let Err(err) = app.emit(ACTIVITY_EVENT, payload) {
        eprintln!("emitting {kind} failed: {err}");
    }
}

/// Remembers the previous observation so the first poll can seed the baseline
/// instead of firing, and compares every poll after that.
struct Tracker<T> {
    seeded: bool,
    value: T,
}

impl<T: Default> Tracker<T> {
    fn new() -> Self {
        Self {
            seeded: false,
            value: T::default(),
        }
    }

    /// True when the value changed *after* the first observation.
    fn changed(&mut self, now: T) -> bool
    where
        T: PartialEq,
    {
        let previous = std::mem::replace(&mut self.value, now);
        if !self.seeded {
            self.seeded = true;
            return false;
        }
        previous != self.value
    }
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

fn watch_power(app: AppHandle) {
    let mut plugged = Tracker::new();

    loop {
        if let Some(status) = power_status()
            && plugged.changed(status.plugged)
        {
            let kind = if status.plugged {
                "power-connected"
            } else {
                "power-disconnected"
            };
            emit(&app, kind, status.percentage);
        }
        std::thread::sleep(POWER_PERIOD);
    }
}

struct PowerStatus {
    plugged: bool,
    /// Already formatted for display, or empty when Windows will not say.
    percentage: String,
}

fn power_status() -> Option<PowerStatus> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status).ok()? };

    // ACLineStatus: 0 offline, 1 online, 255 unknown. A machine with a charger
    // Windows cannot read is treated as no news rather than as a change.
    let plugged = match status.ACLineStatus {
        0 => false,
        1 => true,
        _ => return None,
    };

    // BatteryLifePercent: 255 means "unknown", which is what a desktop reports.
    let percentage = match status.BatteryLifePercent {
        value if value <= 100 => format!("{value}%"),
        _ => String::new(),
    };

    Some(PowerStatus {
        plugged,
        percentage,
    })
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

fn watch_network(app: AppHandle) {
    let mut wifi = Tracker::new();
    let mut ethernet = Tracker::new();

    loop {
        match wifi_ssid() {
            Ok(Some(ssid)) => {
                if wifi.changed(Some(ssid.clone())) {
                    emit(&app, "wifi-connected", ssid);
                }
            }
            // The service answered and nothing is associated.
            Ok(None) => {
                wifi.changed(None);
            }
            // No wireless service or no adapter: not a state change, just an
            // unanswerable question. Leave the baseline alone.
            Err(()) => {}
        }

        if let Ok(up) = ethernet_up()
            && ethernet.changed(up)
            && up
        {
            emit(&app, "ethernet-connected", "");
        }

        std::thread::sleep(NETWORK_PERIOD);
    }
}

/// The SSID of the connected WLAN interface.
///
/// `Ok(None)` means the WLAN service answered and no interface is associated;
/// `Err` means the question could not be asked at all.
fn wifi_ssid() -> Result<Option<String>, ()> {
    unsafe {
        let mut negotiated = 0u32;
        let mut handle = HANDLE::default();
        // Client version 2 is the Windows 10/11 one; the negotiated value comes
        // back in `negotiated` and is what the other calls actually need.
        if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
            return Err(());
        }
        let result = read_wifi_ssid(handle);
        let _ = WlanCloseHandle(handle, None);
        result
    }
}

unsafe fn read_wifi_ssid(handle: HANDLE) -> Result<Option<String>, ()> {
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
    if unsafe { WlanEnumInterfaces(handle, None, &mut list) } != 0 || list.is_null() {
        return Err(());
    }

    let mut ssid = None;
    let interfaces = unsafe {
        std::slice::from_raw_parts(
            (*list).InterfaceInfo.as_ptr(),
            (*list).dwNumberOfItems as usize,
        )
    };

    for interface in interfaces {
        if interface.isState != wlan_interface_state_connected {
            continue;
        }

        let mut size = 0u32;
        let mut data: *mut c_void = std::ptr::null_mut();
        let queried = unsafe {
            WlanQueryInterface(
                handle,
                &interface.InterfaceGuid,
                wlan_intf_opcode_current_connection,
                None,
                &mut size,
                &mut data,
                None,
            )
        };
        if queried != 0 || data.is_null() {
            continue;
        }

        let attributes = unsafe { &*(data as *const WLAN_CONNECTION_ATTRIBUTES) };
        let dot11 = &attributes.wlanAssociationAttributes.dot11Ssid;
        let length = (dot11.uSSIDLength as usize).min(dot11.ucSSID.len());
        ssid = Some(String::from_utf8_lossy(&dot11.ucSSID[..length]).into_owned());
        unsafe { WlanFreeMemory(data as *const c_void) };
        break;
    }

    unsafe { WlanFreeMemory(list as *const c_void) };
    Ok(ssid)
}

/// Whether a *physical* Ethernet link is up.
///
/// `GetIfTable2` reports the interface type, the operational status and - the
/// part that matters here - whether the interface is backed by real hardware.
/// Without that last check a VPN's virtual adapter and the host-only NICs that
/// VirtualBox and Hyper-V leave installed would all count as "a cable".
fn ethernet_up() -> Result<bool, ()> {
    // IANA ifType 6, "ethernetCsmacd". Spelled out because the windows crate
    // does not name these in the Ndis module.
    const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
    /// Bit 0 of `InterfaceAndOperStatusFlags`: `HardwareInterface`.
    const HARDWARE_INTERFACE: u8 = 0x01;

    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).0 != 0 || table.is_null() {
            return Err(());
        }

        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let up = rows.iter().any(|row: &MIB_IF_ROW2| {
            row.Type == IF_TYPE_ETHERNET_CSMACD
                && row.OperStatus == IfOperStatusUp
                && row.InterfaceAndOperStatusFlags._bitfield & HARDWARE_INTERFACE != 0
        });

        FreeMibTable(table as *const c_void);
        Ok(up)
    }
}

// ---------------------------------------------------------------------------
// USB
// ---------------------------------------------------------------------------

fn watch_usb(app: AppHandle) {
    let mut previous: HashMap<String, String> = HashMap::new();
    let mut seeded = false;

    loop {
        let now = match usb_devices() {
            Ok(devices) => devices,
            Err(()) => {
                std::thread::sleep(USB_PERIOD);
                continue;
            }
        };

        if !seeded {
            seeded = true;
            previous = now;
            std::thread::sleep(USB_PERIOD);
            continue;
        }

        let arrived = now.keys().any(|id| !previous.contains_key(id));
        let left = previous.keys().any(|id| !now.contains_key(id));
        if !arrived && !left {
            previous = now;
            std::thread::sleep(USB_PERIOD);
            continue;
        }

        // Let the tree finish settling, then look again: one plug is one
        // indicator, carrying the best name the device gave us.
        std::thread::sleep(USB_SETTLE);
        let settled = usb_devices().unwrap_or(now);

        let added: Vec<String> = settled
            .iter()
            .filter(|(id, _)| !previous.contains_key(*id))
            .map(|(_, name)| name.clone())
            .collect();
        let removed: Vec<String> = previous
            .iter()
            .filter(|(id, _)| !settled.contains_key(*id))
            .map(|(_, name)| name.clone())
            .collect();

        if !added.is_empty() {
            emit(
                &app,
                "usb-connected",
                best_name(added.iter().map(String::as_str)),
            );
        }
        if !removed.is_empty() {
            emit(
                &app,
                "usb-disconnected",
                best_name(removed.iter().map(String::as_str)),
            );
        }

        previous = settled;
        std::thread::sleep(USB_PERIOD);
    }
}

/// Every present device of the USB class, keyed by instance id, with a name to
/// show. The instance id is what makes this a set rather than a count.
fn usb_devices() -> Result<HashMap<String, String>, ()> {
    unsafe {
        let set = SetupDiGetClassDevsW(
            Some(&GUID_DEVCLASS_USB),
            PCWSTR::null(),
            HWND::default(),
            DIGCF_PRESENT,
        )
        .map_err(|_| ())?;

        let mut devices = HashMap::new();
        let mut index = 0u32;

        loop {
            let mut info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInfo(set, index, &mut info).is_err() {
                break;
            }
            index += 1;

            let Some(id) = instance_id(set, &info) else {
                continue;
            };

            // The bus-reported description is the product string the device
            // itself claims ("SanDisk Cruzer Blade"); the friendly name is
            // Windows' class name for it ("USB Mass Storage Device"), which is
            // all a device without a product string ever gets.
            let name = device_string(set, &info, &DEVPKEY_Device_BusReportedDeviceDesc)
                .filter(|name| !name.trim().is_empty())
                .or_else(|| device_string(set, &info, &DEVPKEY_Device_FriendlyName))
                .or_else(|| device_string(set, &info, &DEVPKEY_Device_DeviceDesc))
                .unwrap_or_default();

            devices.insert(id, name);
        }

        let _ = SetupDiDestroyDeviceInfoList(set);
        Ok(devices)
    }
}

unsafe fn instance_id(set: HDEVINFO, info: &SP_DEVINFO_DATA) -> Option<String> {
    let mut required = 0u32;
    let _ = unsafe { SetupDiGetDeviceInstanceIdW(set, info, None, Some(&mut required)) };
    if required == 0 {
        return None;
    }

    let mut buffer = vec![0u16; required as usize];
    unsafe { SetupDiGetDeviceInstanceIdW(set, info, Some(&mut buffer), None).ok()? };
    Some(wide_to_string(&buffer))
}

unsafe fn device_string(set: HDEVINFO, info: &SP_DEVINFO_DATA, key: &DEVPROPKEY) -> Option<String> {
    let mut kind = DEVPROPTYPE::default();
    let mut required = 0u32;
    let _ = unsafe {
        SetupDiGetDevicePropertyW(set, info, key, &mut kind, None, Some(&mut required), 0)
    };
    if required == 0 {
        return None;
    }

    let mut buffer = vec![0u8; required as usize];
    unsafe {
        SetupDiGetDevicePropertyW(set, info, key, &mut kind, Some(&mut buffer), None, 0).ok()?
    };
    if kind != DEVPROP_TYPE_STRING {
        return None;
    }

    let wide: Vec<u16> = buffer
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    Some(wide_to_string(&wide))
}

fn wide_to_string(wide: &[u16]) -> String {
    let end = wide
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end]).trim().to_string()
}

/// Windows' own names for USB device *classes*. A stick enumerates as a
/// composite device plus a mass-storage function, so a plug offers both names
/// and the generic one is the one to drop.
const GENERIC_USB_NAMES: &[&str] = &[
    "USB Composite Device",
    "Composite USB Device",
    "USB Mass Storage Device",
    "USB Input Device",
    "USB Audio Device",
    "USB Video Device",
    "USB Device",
    "Generic USB Hub",
    "USB Root Hub",
    "USB Root Hub (USB 3.0)",
    "USB 2.0 Hub",
    "USB 3.0 Hub",
];

fn best_name<'a>(names: impl Iterator<Item = &'a str>) -> String {
    let generic = |name: &str| {
        GENERIC_USB_NAMES
            .iter()
            .any(|known| known.eq_ignore_ascii_case(name))
    };

    let mut best = "";
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if best.is_empty() || (generic(best) && !generic(name)) {
            best = name;
        }
    }
    best.to_string()
}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

fn watch_bluetooth(app: AppHandle) {
    let mut connected: HashSet<String> = HashSet::new();
    let mut seeded = false;

    loop {
        if let Some(now) = connected_bluetooth() {
            if !seeded {
                seeded = true;
            } else {
                let mut arrived: Vec<&String> = now.difference(&connected).collect();
                arrived.sort();
                for name in arrived {
                    emit(&app, "bluetooth-connected", name.clone());
                }
            }
            connected = now;
        }
        std::thread::sleep(BLUETOOTH_PERIOD);
    }
}

/// The names of the Bluetooth devices connected at this moment.
///
/// `BluetoothFindFirstDevice` answers from the stack's own cache - `fIssueInquiry`
/// is off, so nothing is scanned for - which measures at well under a
/// millisecond here and is what makes a four-second poll affordable. The
/// alternative, enumerating association endpoints through WinRT, was measured
/// at a flat 30 seconds per call, scan or no scan.
///
/// The cost of that choice: this API is the classic (BR/EDR) Bluetooth stack, so
/// a device that speaks nothing but Bluetooth Low Energy - some modern mice and
/// keyboards - never shows up. Everything Windows uses for audio and for phones
/// is classic, so headphones, speakers and handsets are covered.
fn connected_bluetooth() -> Option<HashSet<String>> {
    use windows::Win32::Devices::Bluetooth::{
        BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BluetoothFindDeviceClose,
        BluetoothFindFirstDevice, BluetoothFindNextDevice,
    };
    use windows::Win32::Foundation::BOOL;

    unsafe {
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            // The union of everything the stack knows, then filter on the
            // `fConnected` flag Windows sets for the connection itself.
            fReturnAuthenticated: BOOL(1),
            fReturnRemembered: BOOL(1),
            fReturnUnknown: BOOL(0),
            fReturnConnected: BOOL(1),
            fIssueInquiry: BOOL(0),
            cTimeoutMultiplier: 0,
            hRadio: HANDLE::default(),
        };
        let fresh = || BLUETOOTH_DEVICE_INFO {
            dwSize: size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
            ..Default::default()
        };

        let mut info = fresh();
        let find = BluetoothFindFirstDevice(&params, &mut info).ok()?;

        let mut connected = HashSet::new();
        loop {
            if info.fConnected.as_bool() {
                let name = wide_to_string(&info.szName);
                if !name.is_empty() {
                    connected.insert(name);
                }
            }
            info = fresh();
            if BluetoothFindNextDevice(find, &mut info).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(find);

        Some(connected)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_seeds_before_it_reports() {
        let mut tracker: Tracker<Option<String>> = Tracker::new();
        assert!(!tracker.changed(None), "the first poll is the baseline");
        assert!(tracker.changed(Some("Home".into())));
        assert!(!tracker.changed(Some("Home".into())));
        assert!(tracker.changed(None));
        assert!(
            tracker.changed(Some("Cafe".into())),
            "reconnecting counts again"
        );
    }

    #[test]
    fn best_name_prefers_the_product_string() {
        assert_eq!(
            best_name(["USB Mass Storage Device", "SanDisk Cruzer Blade"].into_iter()),
            "SanDisk Cruzer Blade"
        );
        // Nothing better on offer: the generic name is still worth showing.
        assert_eq!(
            best_name(["USB Composite Device"].into_iter()),
            "USB Composite Device"
        );
        assert_eq!(
            best_name(["USB Root Hub", "USB Gaming Keyboard"].into_iter()),
            "USB Gaming Keyboard"
        );
        assert_eq!(best_name([""].into_iter()), "");
        assert_eq!(best_name(std::iter::empty()), "");
    }
}
