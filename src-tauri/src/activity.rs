//! Activity indicators: what the notch shows *instead of* the clock when the
//! machine changes state.
//!
//! Power/network poll every second and USB every half second. Bluetooth uses
//! incremental Windows connection notifications for both Classic and BLE;
//! cached battery reads run separately so they never hold up a disconnect.
//!
//! The networks are the reason one second is not generous: associating to a
//! wireless network is often over inside two seconds, and the indicator has a
//! phase to show while the attempt is still in flight.
//!
//! The watchers only *notice* and emit. Everything the user sees - the queue,
//! the dwell, the cross-fade with the clock, the phase a network indicator is
//! in - lives in the webview, which is also the only side that knows whether
//! the panel happens to be open and the indicator therefore has to wait.
//!
//! Two rules are baked into every watcher:
//!
//! * The first successful poll only seeds a baseline. A machine that boots with
//!   the charger in, a network up and three USB devices attached must not queue
//!   half a dozen indicators the moment the app starts.
//! * Nothing is emitted for a state that merely *ends*, except where the user
//!   asked for it: the charger and USB report both directions, and so do the
//!   networks - an attempt that gives up is worth a notice, but only if the
//!   notch was already showing that network, which is the webview's call.
//!   Bluetooth disconnects only cancel pending notices, never show one of their own.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Device_IDW, CM_Get_Parent, CR_SUCCESS, DIGCF_ALLCLASSES, DIGCF_DEVICEINTERFACE,
    DIGCF_PRESENT, GUID_DEVCLASS_DISKDRIVE, HDEVINFO, SP_DEVICE_INTERFACE_DATA,
    SP_DEVICE_INTERFACE_DETAIL_DATA_W, SP_DEVINFO_DATA, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInfo, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceInterfaceDetailW, SetupDiGetDevicePropertyW,
};
use windows::Win32::Devices::Properties::{
    DEVPKEY_Device_BusReportedDeviceDesc, DEVPKEY_Device_CompatibleIds, DEVPKEY_Device_DeviceDesc,
    DEVPKEY_Device_FriendlyName, DEVPKEY_Device_Service, DEVPROP_TYPE_STRING,
    DEVPROP_TYPE_STRING_LIST, DEVPROPKEY, DEVPROPTYPE,
};
use windows::Win32::Foundation::{CloseHandle, ERROR_NO_MORE_ITEMS, HANDLE, HWND};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::Ndis::{IfOperStatusUp, MediaConnectStateConnected};
use windows::Win32::NetworkManagement::WiFi::{
    WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST, WlanCloseHandle, WlanEnumInterfaces,
    WlanFreeMemory, WlanOpenHandle, WlanQueryInterface, wlan_interface_state_associating,
    wlan_interface_state_authenticating, wlan_interface_state_connected,
    wlan_interface_state_discovering, wlan_intf_opcode_current_connection,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::Win32::System::Ioctl::{DISK_GEOMETRY_EX, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::core::{GUID, PCWSTR};

mod bluetooth;

/// USB and Bluetooth also carry connection identities and optional metadata.
pub const ACTIVITY_EVENT: &str = "notch-activity";

const POWER_PERIOD: Duration = Duration::from_millis(1000);
/// Short on purpose: an association can be over inside two seconds, and the
/// indicator shows a phase of its own while one is in flight.
const NETWORK_PERIOD: Duration = Duration::from_millis(1000);
const USB_PERIOD: Duration = Duration::from_millis(500);
const USB_TIMEOUT: Duration = Duration::from_secs(12);

/// Minimum age before metadata can complete. Detection/removal are not delayed:
/// the tree can grow while the frontend is already showing its reading phase.
const USB_SETTLE: Duration = Duration::from_millis(700);

/// One indicator. `kind` picks the icon and the wording, `detail` is the part
/// that comes from the machine: the battery percentage, the SSID, a device name.
#[derive(Clone, serde::Serialize)]
pub struct Activity {
    pub kind: &'static str,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usb: Option<UsbPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bluetooth: Option<bluetooth::BluetoothPayload>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPayload {
    /// Unique to this attachment, not just its port: a late disk query from a
    /// previous insertion must never complete a new one in the same port.
    device_id: String,
    capacity_bytes: Option<u64>,
}

pub fn install(app: &AppHandle) {
    spawn(app, "activity-power", watch_power);
    spawn(app, "activity-network", watch_network);
    spawn(app, "activity-usb", watch_usb);
    spawn(app, "activity-bluetooth", bluetooth::watch);
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
        usb: None,
        bluetooth: None,
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

/// What the WLAN service says, collapsed into the three states an indicator can
/// show. An attempt is a state of its own because a connection that is still in
/// flight is what the indicator's first phase is about.
#[derive(Clone, PartialEq, Eq)]
enum Wifi {
    /// The service answered and no interface is associated.
    Idle,
    /// An attempt is in flight: associating, discovering or authenticating.
    Connecting,
    /// Associated, on this SSID.
    Connected(String),
}

/// The cable, as the interface table reports it.
///
/// `Detected` is the media state on its own - something is plugged in at the far
/// end - which arrives a moment before Windows brings the interface up on it.
/// That gap is real, if short, and it is what the "cable detected" phase shows;
/// a driver that goes straight to up simply never reports it.
#[derive(Clone, PartialEq, Eq)]
enum Ethernet {
    Gone,
    Detected,
    /// Up, at this link speed in bits per second.
    Up(u64),
}

fn watch_network(app: AppHandle) {
    // The first answer of each kind only seeds the baseline, the rule every
    // watcher here follows: a machine that is already on Wi-Fi when the app
    // starts has nothing to announce. An unauthorised-for question leaves the
    // baseline alone rather than resetting it.
    let mut wifi: Option<Wifi> = None;
    let mut ethernet: Option<Ethernet> = None;

    loop {
        if let Ok(now) = wifi_state() {
            if let Some(was) = wifi.take()
                && let Some((kind, detail)) = wifi_event(&was, &now)
            {
                emit(&app, kind, detail);
            }
            wifi = Some(now);
        }

        if let Ok(now) = ethernet_state() {
            if let Some(was) = ethernet.take()
                && let Some((kind, detail)) = ethernet_event(&was, &now)
            {
                emit(&app, kind, detail);
            }
            ethernet = Some(now);
        }

        std::thread::sleep(NETWORK_PERIOD);
    }
}

/// What a Wi-Fi change is worth announcing, if anything.
///
/// Both ends of an attempt are reported - it started, and it gave up - because a
/// connection the user just asked for is worth watching; the webview drops the
/// ending if the notch was not already showing that network.
fn wifi_event(was: &Wifi, now: &Wifi) -> Option<(&'static str, String)> {
    // The poll runs every second and usually finds nothing new. Reporting the
    // same state again would restart the indicator's own clock every second.
    if was == now {
        return None;
    }

    match now {
        Wifi::Connecting => Some(("wifi-connecting", String::new())),
        // Any arrival counts, including moving to a different network.
        Wifi::Connected(ssid) => Some(("wifi-connected", ssid.clone())),
        // What is left is a connection that just ended, whether it had got
        // anywhere or not.
        Wifi::Idle => Some(("wifi-lost", String::new())),
    }
}

/// The same for the cable. There is no "connecting" here: a wired interface
/// either has the link or it does not, and the speed comes with it.
fn ethernet_event(was: &Ethernet, now: &Ethernet) -> Option<(&'static str, String)> {
    if was == now {
        return None;
    }

    match (was, now) {
        (_, Ethernet::Up(speed)) => Some(("ethernet-connected", link_speed(*speed))),
        (Ethernet::Gone, Ethernet::Detected) => Some(("ethernet-detected", String::new())),
        // What is left is a link that is no longer up: the cable was pulled, or
        // Windows took the interface down while it stayed in. Both read the same
        // from here, and neither should be announced as a fresh cable.
        _ => Some(("ethernet-lost", String::new())),
    }
}

/// The link's own rate, in the units a person reads: bits per second in,
/// "1 Gbps" out.
///
/// This is the rate of the port, and not of whatever the network behind it is
/// doing: a gigabit port on a slow line still reads 1 Gbps, which is what the
/// label on the port means everywhere else. Windows reports zero, and on a few
/// drivers a full 32-bit mask, when it does not know.
fn link_speed(bits: u64) -> String {
    const UNITS: [(u64, &str); 3] = [
        (1_000_000_000, "Gbps"),
        (1_000_000, "Mbps"),
        (1_000, "Kbps"),
    ];

    if bits == 0 || bits == u32::MAX as u64 {
        return String::new();
    }

    let Some((scale, unit)) = UNITS.iter().find(|(scale, _)| bits >= *scale) else {
        return String::new();
    };

    // Two decimals is plenty for a link rate, and it keeps 2.5 Gbps from
    // arriving as 2.499999 or 2.5000000001.
    let value = (bits as f64 / *scale as f64 * 100.0).round() / 100.0;
    format!("{value} {unit}")
}

/// The state of the wireless interfaces, or `Err` when the question cannot be
/// asked at all (no wireless service, no adapter).
fn wifi_state() -> Result<Wifi, ()> {
    unsafe {
        let mut negotiated = 0u32;
        let mut handle = HANDLE::default();
        // Client version 2 is the Windows 10/11 one; the negotiated value comes
        // back in `negotiated` and is what the other calls actually need.
        if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
            return Err(());
        }
        let result = read_wifi_state(handle);
        let _ = WlanCloseHandle(handle, None);
        result
    }
}

/// Walks the WLAN interfaces and reports the most useful thing they say.
///
/// One wireless card is the usual case and answers for itself; with several, a
/// connected one wins, then one that is on its way in, and nothing making an
/// attempt means idle.
unsafe fn read_wifi_state(handle: HANDLE) -> Result<Wifi, ()> {
    let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
    if unsafe { WlanEnumInterfaces(handle, None, &mut list) } != 0 || list.is_null() {
        return Err(());
    }

    let interfaces = unsafe {
        std::slice::from_raw_parts(
            (*list).InterfaceInfo.as_ptr(),
            (*list).dwNumberOfItems as usize,
        )
    };

    let mut state = Wifi::Idle;
    for interface in interfaces {
        let now = interface.isState;
        if now == wlan_interface_state_connected {
            let ssid = unsafe { wifi_ssid(handle, &interface.InterfaceGuid) }.unwrap_or_default();
            state = Wifi::Connected(ssid);
            break;
        }
        // Associating, discovering and authenticating are the three shapes an
        // attempt wears while it is in flight. Not ready, disconnecting,
        // disconnected and ad-hoc are none of them a connection on its way in,
        // so they leave the answer alone.
        if now == wlan_interface_state_associating
            || now == wlan_interface_state_discovering
            || now == wlan_interface_state_authenticating
        {
            state = Wifi::Connecting;
        }
    }

    unsafe { WlanFreeMemory(list as *const c_void) };
    Ok(state)
}

/// The SSID an associated interface is on, if Windows will say.
unsafe fn wifi_ssid(handle: HANDLE, guid: &GUID) -> Option<String> {
    let mut size = 0u32;
    let mut data: *mut c_void = std::ptr::null_mut();
    let queried = unsafe {
        WlanQueryInterface(
            handle,
            guid,
            wlan_intf_opcode_current_connection,
            None,
            &mut size,
            &mut data,
            None,
        )
    };
    if queried != 0 || data.is_null() {
        return None;
    }

    let attributes = unsafe { &*(data as *const WLAN_CONNECTION_ATTRIBUTES) };
    let dot11 = &attributes.wlanAssociationAttributes.dot11Ssid;
    let length = (dot11.uSSIDLength as usize).min(dot11.ucSSID.len());
    let ssid = String::from_utf8_lossy(&dot11.ucSSID[..length]).into_owned();
    unsafe { WlanFreeMemory(data as *const c_void) };
    Some(ssid)
}

/// Whether a cable is in and what the port negotiated, over the *physical*
/// interfaces only.
///
/// `GetIfTable2` reports the interface type, the media state, the operational
/// status and - the part that matters here - whether the interface is backed by
/// real hardware. Without that last check a VPN's virtual adapter and the
/// host-only NICs that VirtualBox and Hyper-V leave installed would all count as
/// "a cable".
fn ethernet_state() -> Result<Ethernet, ()> {
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
        let mut state = Ethernet::Gone;

        for row in rows {
            if row.Type != IF_TYPE_ETHERNET_CSMACD
                || row.InterfaceAndOperStatusFlags._bitfield & HARDWARE_INTERFACE == 0
            {
                continue;
            }

            // The media state is the cable itself. It comes up before Windows has
            // finished bringing the interface up on it, and the interface being
            // down while the cable is in is what "detected" names.
            if row.MediaConnectState != MediaConnectStateConnected {
                continue;
            }

            if row.OperStatus == IfOperStatusUp {
                // More than one cable up - a dock and the machine's own port -
                // reports whichever Windows lists first.
                state = Ethernet::Up(row.TransmitLinkSpeed);
                break;
            }

            state = Ethernet::Detected;
        }

        FreeMibTable(table as *const c_void);
        Ok(state)
    }
}

// ---------------------------------------------------------------------------
// USB
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct UsbDevice {
    name: String,
    storage: bool,
}

struct UsbAttachment {
    token: String,
    since: Instant,
    ready: bool,
}

fn emit_usb(app: &AppHandle, kind: &'static str, token: &str, name: &str, capacity: Option<u64>) {
    let payload = Activity {
        kind,
        detail: name.to_string(),
        usb: Some(UsbPayload {
            device_id: token.to_string(),
            capacity_bytes: capacity,
        }),
        bluetooth: None,
    };
    if let Err(err) = app.emit(ACTIVITY_EVENT, payload) {
        eprintln!("emitting {kind} failed: {err}");
    }
}

/// One capacity worker, bounded to one outstanding request. A driver that hangs
/// on an IOCTL cannot block removals or create an unbounded number of threads.
fn watch_usb(app: AppHandle) {
    type Request = Vec<(String, String)>;
    let (request_tx, request_rx) = mpsc::sync_channel::<Request>(1);
    let (result_tx, result_rx) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("usb-capacity".into())
        .spawn(move || {
            while let Ok(request) = request_rx.recv() {
                let capacities = usb_capacities(&request);
                if result_tx.send((request, capacities)).is_err() {
                    break;
                }
            }
        });

    let mut previous: HashMap<String, UsbDevice> = HashMap::new();
    let mut attached: HashMap<String, UsbAttachment> = HashMap::new();
    let mut seeded = false;
    let mut serial = 0u64;
    let mut querying = false;

    loop {
        let now = match usb_devices() {
            Ok(devices) => devices,
            Err(()) => {
                std::thread::sleep(USB_PERIOD);
                continue;
            }
        };
        // Sort transitions for a stable ordering when a hub brings several
        // physical devices in together. Functions of one device are grouped.
        let mut roots: Vec<_> = now.keys().cloned().collect();
        roots.sort();
        for root in roots {
            if !previous.contains_key(&root) {
                serial += 1;
                let token = format!("{root}#{serial}");
                if seeded {
                    emit_usb(&app, "usb-connected", &token, &now[&root].name, None);
                }
                attached.insert(
                    root,
                    UsbAttachment {
                        token,
                        since: Instant::now(),
                        ready: !seeded,
                    },
                );
            }
        }
        let mut removed: Vec<_> = previous
            .keys()
            .filter(|id| !now.contains_key(*id))
            .cloned()
            .collect();
        removed.sort();
        for root in removed {
            if let Some(device) = attached.remove(&root) {
                emit_usb(
                    &app,
                    "usb-disconnected",
                    &device.token,
                    &previous[&root].name,
                    None,
                );
            }
        }
        seeded = true;

        let mut capacities = HashMap::new();
        if let Ok((request, result)) = result_rx.try_recv() {
            querying = false;
            for (root, token) in request {
                // Discard replies for a device removed/reinserted in the meantime.
                if attached.get(&root).is_some_and(|item| item.token == token)
                    && let Some(bytes) = result.get(&root)
                {
                    capacities.insert(root, *bytes);
                }
            }
        }
        for (root, item) in &mut attached {
            let device = &now[root];
            let capacity = capacities.get(root).copied();
            if !item.ready && usb_metadata_ready(item.since.elapsed(), device, capacity) {
                item.ready = true;
                emit_usb(&app, "usb-ready", &item.token, &device.name, capacity);
            }
        }
        if !querying {
            let request: Request = attached
                .iter()
                .filter(|(root, item)| {
                    !item.ready && now[*root].storage && item.since.elapsed() >= USB_SETTLE
                })
                .map(|(root, item)| (root.clone(), item.token.clone()))
                .collect();
            if !request.is_empty() && request_tx.try_send(request).is_ok() {
                querying = true;
            }
        }
        previous = now;
        std::thread::sleep(USB_PERIOD);
    }
}

fn usb_metadata_ready(elapsed: Duration, device: &UsbDevice, capacity: Option<u64>) -> bool {
    elapsed >= USB_TIMEOUT
        || (elapsed >= USB_SETTLE
            && ((!device.storage && !device.name.is_empty()) || capacity.is_some()))
}

/// A physical USB node, not its HID/audio/storage functions. Walking upward also
/// maps UASP/SCSI disks and composite functions to the same attachment.
fn physical_usb_id(id: &str) -> bool {
    let upper = id.to_ascii_uppercase();
    let hardware = upper.split('\\').nth(1).unwrap_or_default();
    upper.starts_with("USB\\VID_") && !hardware.contains("&MI_")
}

unsafe fn usb_root(mut node: u32) -> Option<String> {
    for _ in 0..32 {
        let mut id = [0u16; 512];
        if unsafe { CM_Get_Device_IDW(node, &mut id, 0) } != CR_SUCCESS {
            return None;
        }
        let id = wide_to_string(&id);
        if physical_usb_id(&id) {
            return Some(id);
        }
        let mut parent = 0;
        if unsafe { CM_Get_Parent(&mut parent, node, 0) } != CR_SUCCESS {
            return None;
        }
        node = parent;
    }
    None
}

/// Enumerate all setup classes: HID-only devices are not necessarily members of
/// GUID_DEVCLASS_USB. Keep one entry per physical ancestor, not per function.
fn usb_devices() -> Result<HashMap<String, UsbDevice>, ()> {
    unsafe {
        let set = SetupDiGetClassDevsW(
            None,
            PCWSTR::null(),
            HWND::default(),
            DIGCF_PRESENT | DIGCF_ALLCLASSES,
        )
        .map_err(|_| ())?;

        let mut devices = HashMap::new();
        let mut root_names = HashMap::new();
        let mut index = 0u32;

        loop {
            let mut info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if let Err(error) = SetupDiEnumDeviceInfo(set, index, &mut info) {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_ITEMS.0) {
                    break;
                }
                // An incomplete enumeration is not evidence of removal.
                let _ = SetupDiDestroyDeviceInfoList(set);
                return Err(());
            }
            index += 1;

            let Some(id) = usb_root(info.DevInst) else {
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

            if instance_id(set, &info).as_deref() == Some(id.as_str()) {
                root_names.insert(id.clone(), name.clone());
            }

            let compatible =
                device_string(set, &info, &DEVPKEY_Device_CompatibleIds).unwrap_or_default();
            let service = device_string(set, &info, &DEVPKEY_Device_Service).unwrap_or_default();
            let storage = info.ClassGuid == GUID_DEVCLASS_DISKDRIVE
                || compatible.to_ascii_uppercase().contains("USB\\CLASS_08")
                || service.eq_ignore_ascii_case("USBSTOR")
                || service.eq_ignore_ascii_case("UASPStor");
            let device: &mut UsbDevice = devices.entry(id).or_default();
            device.name = best_name([device.name.as_str(), name.as_str()].into_iter());
            device.storage |= storage;
        }

        for (id, name) in root_names {
            if let Some(device) = devices.get_mut(&id) {
                device.name = best_name([name.as_str(), device.name.as_str()].into_iter());
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
        Ok(devices)
    }
}

/// Capacity of the entire physical disk, not free space or a drive-letter's
/// partition size. FILE_ANY_ACCESS geometry queries work without administrator
/// privileges. Never read user files or mount/unlock a volume to obtain this.
fn usb_capacities(request: &[(String, String)]) -> HashMap<String, u64> {
    const DISK: GUID = GUID::from_u128(0x53f56307_b6bf_11d0_94f2_00a0c91efb8b);
    let mut capacities = HashMap::new();
    let mut unavailable = HashSet::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(
            Some(&DISK),
            PCWSTR::null(),
            HWND::default(),
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        ) else {
            return capacities;
        };
        let mut index = 0;
        loop {
            let mut interface = SP_DEVICE_INTERFACE_DATA {
                cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInterfaces(set, None, &DISK, index, &mut interface).is_err() {
                break;
            }
            index += 1;
            let mut required = 0;
            let _ = SetupDiGetDeviceInterfaceDetailW(
                set,
                &interface,
                None,
                0,
                Some(&mut required),
                None,
            );
            if required < size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32 {
                continue;
            }
            // u64 storage gives the detail header its native alignment.
            let mut buffer = vec![0u64; (required as usize).div_ceil(8)];
            let detail = buffer
                .as_mut_ptr()
                .cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>();
            (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            let mut info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiGetDeviceInterfaceDetailW(
                set,
                &interface,
                Some(detail),
                required,
                None,
                Some(&mut info),
            )
            .is_err()
            {
                continue;
            }
            let Some(root) = usb_root(info.DevInst) else {
                continue;
            };
            if !request.iter().any(|(id, _)| *id == root) {
                continue;
            }
            let path = PCWSTR(std::ptr::addr_of!((*detail).DevicePath).cast());
            let Ok(handle) = CreateFileW(
                path,
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                HANDLE::default(),
            ) else {
                unavailable.insert(root);
                continue;
            };
            let mut output = [0u64; 64];
            let mut returned = 0;
            let result = DeviceIoControl(
                handle,
                IOCTL_DISK_GET_DRIVE_GEOMETRY_EX,
                None,
                0,
                Some(output.as_mut_ptr().cast()),
                size_of_val(&output) as u32,
                Some(&mut returned),
                None,
            );
            let _ = CloseHandle(handle);
            if result.is_ok() && returned as usize >= size_of::<DISK_GEOMETRY_EX>() {
                let bytes = (*(output.as_ptr().cast::<DISK_GEOMETRY_EX>())).DiskSize;
                if bytes > 0 {
                    *capacities.entry(root).or_default() += bytes as u64;
                } else {
                    unavailable.insert(root);
                }
            } else {
                unavailable.insert(root);
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    // Multi-LUN devices must not advertise a partial sum as their total size.
    capacities.retain(|root, _| !unavailable.contains(root));
    capacities
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
    if kind != DEVPROP_TYPE_STRING && kind != DEVPROP_TYPE_STRING_LIST {
        return None;
    }

    let wide: Vec<u16> = buffer
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    Some(
        wide.split(|unit| *unit == 0)
            .filter(|part| !part.is_empty())
            .map(String::from_utf16_lossy)
            .collect::<Vec<_>>()
            .join(" "),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usb_functions_share_the_physical_parent() {
        assert!(physical_usb_id(r"USB\VID_0781&PID_5567\1234"));
        assert!(physical_usb_id(r"usb\vid_046d&pid_c548\receiver"));
        assert!(!physical_usb_id(r"USB\VID_046D&PID_C548&MI_01\1234"));
        assert!(!physical_usb_id(r"HID\VID_046D&PID_C548\1234"));
        assert!(!physical_usb_id(r"USBSTOR\DISK&VEN_SANDISK\1234"));
        assert!(!physical_usb_id(r"USB\ROOT_HUB30\1234"));
    }

    #[test]
    fn usb_metadata_waits_for_windows_but_has_a_deadline() {
        let storage = UsbDevice {
            name: "SanDisk".into(),
            storage: true,
        };
        let mouse = UsbDevice {
            name: "Mouse".into(),
            storage: false,
        };
        assert!(!usb_metadata_ready(Duration::ZERO, &mouse, None));
        assert!(usb_metadata_ready(USB_SETTLE, &mouse, None));
        assert!(!usb_metadata_ready(USB_SETTLE, &storage, None));
        assert!(usb_metadata_ready(
            USB_SETTLE,
            &storage,
            Some(32_000_000_000)
        ));
        assert!(!usb_metadata_ready(USB_SETTLE, &UsbDevice::default(), None));
        assert!(usb_metadata_ready(USB_TIMEOUT, &storage, None));
        assert!(usb_metadata_ready(USB_TIMEOUT, &UsbDevice::default(), None));
    }

    #[test]
    #[ignore = "manual Windows USB inventory and read-only capacity probe"]
    fn usb_hardware_inventory() {
        let devices = usb_devices().expect("enumerate USB tree");
        let request: Vec<_> = devices
            .keys()
            .map(|root| (root.clone(), "probe".into()))
            .collect();
        let capacities = usb_capacities(&request);
        for (root, device) in devices {
            println!(
                "{} storage={} capacity={:?}",
                device.name,
                device.storage,
                capacities.get(&root)
            );
        }
    }

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

    #[test]
    fn wifi_reports_both_ends_of_an_attempt() {
        let event = |was, now| wifi_event(&was, &now).map(|(kind, _)| kind);

        assert_eq!(event(Wifi::Idle, Wifi::Connecting), Some("wifi-connecting"));
        assert_eq!(
            event(Wifi::Connecting, Wifi::Connected("Home".into())),
            Some("wifi-connected")
        );
        // Windows often goes idle to connected without stopping at connecting;
        // the indicator still has an arrival to play, and says so itself.
        assert_eq!(
            event(Wifi::Idle, Wifi::Connected("Home".into())),
            Some("wifi-connected")
        );
        // Both the attempt that gave up and the link that dropped end the same
        // way here; which of the two it was is the webview's story to tell.
        assert_eq!(event(Wifi::Connecting, Wifi::Idle), Some("wifi-lost"));
        assert_eq!(
            event(Wifi::Connected("Home".into()), Wifi::Idle),
            Some("wifi-lost")
        );
        assert_eq!(
            event(
                Wifi::Connected("Home".into()),
                Wifi::Connected("Cafe".into())
            ),
            Some("wifi-connected")
        );
        // The same state twice is what most polls find, and it says nothing:
        // repeating it would restart the indicator's own clock every second.
        assert_eq!(
            event(
                Wifi::Connected("Home".into()),
                Wifi::Connected("Home".into())
            ),
            None
        );
        assert_eq!(event(Wifi::Idle, Wifi::Idle), None);
        assert_eq!(event(Wifi::Connecting, Wifi::Connecting), None);
    }

    #[test]
    fn ethernet_reports_the_cable_and_then_the_link() {
        let event = |was, now| ethernet_event(&was, &now).map(|(kind, _)| kind);

        assert_eq!(
            event(Ethernet::Gone, Ethernet::Detected),
            Some("ethernet-detected")
        );
        assert_eq!(
            event(Ethernet::Detected, Ethernet::Up(1_000_000_000)),
            Some("ethernet-connected")
        );
        // A driver that brings the interface up in the same breath skips the
        // detected phase, and there is nothing to report in between.
        assert_eq!(
            event(Ethernet::Gone, Ethernet::Up(1_000_000_000)),
            Some("ethernet-connected")
        );
        assert_eq!(
            event(Ethernet::Up(1_000_000_000), Ethernet::Gone),
            Some("ethernet-lost")
        );
        assert_eq!(
            event(Ethernet::Detected, Ethernet::Gone),
            Some("ethernet-lost")
        );
        assert_eq!(
            event(Ethernet::Up(1_000_000_000), Ethernet::Detected),
            Some("ethernet-lost")
        );
        assert_eq!(event(Ethernet::Gone, Ethernet::Gone), None);
        assert_eq!(event(Ethernet::Detected, Ethernet::Detected), None);
        assert_eq!(
            event(Ethernet::Up(1_000_000_000), Ethernet::Up(1_000_000_000)),
            None
        );
    }

    #[test]
    fn ethernet_carries_the_link_speed() {
        assert_eq!(
            ethernet_event(&Ethernet::Detected, &Ethernet::Up(100_000_000))
                .unwrap()
                .1,
            "100 Mbps"
        );
    }

    #[test]
    fn link_speed_reads_in_the_units_a_person_knows() {
        assert_eq!(link_speed(1_000_000_000), "1 Gbps");
        assert_eq!(link_speed(2_500_000_000), "2.5 Gbps");
        assert_eq!(link_speed(10_000_000_000), "10 Gbps");
        assert_eq!(link_speed(100_000_000), "100 Mbps");
        assert_eq!(link_speed(10_000_000), "10 Mbps");
        // Windows says zero, or a full mask, when it does not know: better to
        // leave the label off than to invent a number.
        assert_eq!(link_speed(0), "");
        assert_eq!(link_speed(u32::MAX as u64), "");
    }
}
