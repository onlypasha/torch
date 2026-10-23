//! Passive Bluetooth connection notifications, shared by Classic and BLE.
//!
//! DeviceWatcher is incremental: unlike FindAllAsync it does not block the
//! indicator waiting for an entire discovery pass. Only IsConnected transitions
//! count, not pairing, adapter power, or seeing a nearby advertisement. No
//! BluetoothDevice/GATT object is opened and no connection/pairing API is called.

use super::{ACTIVITY_EVENT, Activity, wide_to_string};
use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Devices::Enumeration::{
    DeviceInformation, DeviceInformationKind, DeviceInformationUpdate, DeviceWatcher,
};
use windows::Foundation::Collections::{IIterable, IMapView};
use windows::Foundation::{IPropertyValue, TypedEventHandler};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_Device_IDW, CM_Get_Parent, CR_SUCCESS, DIGCF_ALLCLASSES, DIGCF_PRESENT, SP_DEVINFO_DATA,
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDevicePropertyW,
};
use windows::Win32::Devices::Properties::{
    DEVPKEY_Device_ContainerId, DEVPROP_TYPE_BYTE, DEVPROP_TYPE_GUID, DEVPROP_TYPE_UINT16,
    DEVPROP_TYPE_UINT32, DEVPROPKEY, DEVPROPTYPE,
};
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, HWND};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::{GUID, HRESULT, HSTRING, IInspectable, Interface, PCWSTR};

const CONNECTED: &str = "System.Devices.Aep.IsConnected";
const CONTAINER: &str = "System.Devices.Aep.ContainerId";
const ADDRESS: &str = "System.Devices.Aep.DeviceAddress";
const NAME: &str = "System.ItemNameDisplay";
const BATTERY: &str = "System.Devices.BatteryLife";
// Protocol identifiers documented for Bluetooth and Bluetooth LE AEPs.
const SELECTOR: &str = "(System.Devices.Aep.ProtocolId:=\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\" OR System.Devices.Aep.ProtocolId:=\"{bb7bb05e-5972-42b5-94fc-76eaa7084d49}\")";
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothPayload {
    device_id: String,
    battery_percent: Option<u8>,
}

#[derive(Clone, Debug, Default)]
struct Endpoint {
    name: String,
    connected: bool,
    container: Option<String>,
    address: Option<String>,
    battery: Option<u8>,
}

#[derive(Default)]
struct Patch {
    name: Option<String>,
    connected: Option<bool>,
    container: Option<String>,
    address: Option<String>,
    battery: Option<u8>,
}

#[derive(Clone, Debug)]
struct Live {
    token: String,
    aliases: HashSet<String>,
    name: String,
    battery: Option<u8>,
}

#[derive(Debug)]
struct Change {
    kind: &'static str,
    detail: String,
    payload: BluetoothPayload,
}

impl Live {
    fn event(&self, kind: &'static str) -> Change {
        Change {
            kind,
            detail: self.name.clone(),
            payload: BluetoothPayload {
                device_id: self.token.clone(),
                battery_percent: self.battery,
            },
        }
    }
}

/// Pure state machine. Alias sets join a Classic and BLE endpoint by container
/// or address, never product name. Tokens belong to a connection lifetime, so a
/// late battery reply cannot modify a later connection in the same device.
#[derive(Default)]
struct Tracker {
    endpoints: HashMap<String, Endpoint>,
    live: Vec<Live>,
    seeded: bool,
}

impl Tracker {
    fn update(&mut self, id: String, patch: Patch) -> Vec<Change> {
        let endpoint = self.endpoints.entry(id).or_default();
        if let Some(name) = patch.name {
            endpoint.name = name;
        }
        if let Some(connected) = patch.connected {
            endpoint.connected = connected;
        }
        if let Some(container) = patch.container {
            endpoint.container = Some(container);
        }
        if let Some(address) = patch.address {
            endpoint.address = Some(address);
        }
        if let Some(battery) = patch.battery {
            endpoint.battery = Some(battery);
        }
        if self.seeded {
            self.reconcile()
        } else {
            Vec::new()
        }
    }

    fn remove(&mut self, id: &str) -> Vec<Change> {
        self.endpoints.remove(id);
        if self.seeded {
            self.reconcile()
        } else {
            Vec::new()
        }
    }

    fn seed(&mut self) {
        self.reconcile();
        self.seeded = true;
    }

    fn reconcile(&mut self) -> Vec<Change> {
        let mut groups: Vec<Live> = Vec::new();
        let mut endpoints: Vec<_> = self.endpoints.iter().filter(|(_, e)| e.connected).collect();
        endpoints.sort_by_key(|(id, _)| *id);
        for (id, endpoint) in endpoints {
            let mut aliases = HashSet::from([format!("endpoint:{id}")]);
            if let Some(container) = &endpoint.container {
                aliases.insert(format!("container:{container}"));
            }
            if let Some(address) = &endpoint.address {
                aliases.insert(format!("address:{address}"));
            }
            let mut group = Live {
                token: String::new(),
                aliases,
                name: endpoint.name.clone(),
                battery: endpoint.battery,
            };
            let mut at = 0;
            while at < groups.len() {
                if !groups[at].aliases.is_disjoint(&group.aliases) {
                    let other = groups.remove(at);
                    group.aliases.extend(other.aliases);
                    if group.name.is_empty() {
                        group.name = other.name;
                    }
                    group.battery = group.battery.or(other.battery);
                    at = 0; // Joining can bridge two groups previously separate.
                } else {
                    at += 1;
                }
            }
            groups.push(group);
        }
        let mut old = std::mem::take(&mut self.live);
        let mut changes = Vec::new();
        for mut group in groups {
            if let Some(at) = old
                .iter()
                .position(|live| !live.aliases.is_disjoint(&group.aliases))
            {
                let previous = old.remove(at);
                group.token = previous.token.clone();
                // Keep learned aliases while this connection lives; a late
                // ContainerId must not turn a rename into a second arrival.
                group.aliases.extend(previous.aliases.iter().cloned());
                if group.name.is_empty() {
                    group.name = previous.name.clone();
                }
                group.battery = group.battery.or(previous.battery);
                if group.name != previous.name || group.battery != previous.battery {
                    changes.push(group.event("bluetooth-updated"));
                }
            } else {
                group.token = format!(
                    "bluetooth-{}",
                    NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed)
                );
                changes.push(group.event("bluetooth-connected"));
            }
            self.live.push(group);
        }
        changes.extend(old.iter().map(|live| live.event("bluetooth-disconnected")));
        changes
    }

    fn battery(&mut self, token: &str, level: u8) -> Option<Change> {
        let device = self.live.iter_mut().find(|live| live.token == token)?;
        if level > 100 || device.battery == Some(level) {
            return None;
        }
        device.battery = Some(level);
        let aliases = device.aliases.clone();
        let event = device.event("bluetooth-updated");
        // Keep subsequent non-battery endpoint updates from restoring an older
        // AEP battery value over this fresher cached PnP value.
        for (id, endpoint) in &mut self.endpoints {
            let matches = aliases.contains(&format!("endpoint:{id}"))
                || endpoint
                    .container
                    .as_ref()
                    .is_some_and(|id| aliases.contains(&format!("container:{id}")))
                || endpoint
                    .address
                    .as_ref()
                    .is_some_and(|id| aliases.contains(&format!("address:{id}")));
            if matches {
                endpoint.battery = Some(level);
            }
        }
        Some(event)
    }
}

fn address(value: &str) -> Option<String> {
    let compact: String = value
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | ' '))
        .collect();
    (compact.len() == 12
        && compact.bytes().all(|c| c.is_ascii_hexdigit())
        && compact != "000000000000")
        .then(|| compact.to_ascii_lowercase())
}

fn container(guid: GUID) -> Option<String> {
    (guid != GUID::zeroed()).then(|| format!("{guid:?}").to_ascii_lowercase())
}

type Properties = IMapView<HSTRING, IInspectable>;
fn property(properties: &Properties, key: &str) -> Option<IPropertyValue> {
    properties.Lookup(&HSTRING::from(key)).ok()?.cast().ok()
}

fn patch(properties: &Properties) -> Patch {
    let integer = property(properties, BATTERY).and_then(|v| {
        v.GetUInt32()
            .ok()
            .or_else(|| v.GetUInt16().ok().map(u32::from))
            .or_else(|| v.GetUInt8().ok().map(u32::from))
    });
    Patch {
        name: property(properties, NAME)
            .and_then(|v| v.GetString().ok())
            .map(|s| s.to_string_lossy()),
        connected: property(properties, CONNECTED).and_then(|v| v.GetBoolean().ok()),
        container: property(properties, CONTAINER)
            .and_then(|v| v.GetGuid().ok())
            .and_then(container),
        address: property(properties, ADDRESS)
            .and_then(|v| v.GetString().ok())
            .and_then(|s| address(&s.to_string_lossy())),
        battery: integer
            .filter(|level| *level <= 100)
            .map(|level| level as u8),
    }
}

enum Message {
    Added(String, Patch),
    Updated(String, Patch),
    Removed(String),
    Seed,
    Stopped,
    Battery(Vec<(String, u8)>),
}

fn publish(app: &AppHandle, changes: Vec<Change>) {
    for change in changes {
        let payload = Activity {
            kind: change.kind,
            detail: change.detail,
            usb: None,
            bluetooth: Some(change.payload),
        };
        if let Err(error) = app.emit(ACTIVITY_EVENT, payload) {
            eprintln!("emitting Bluetooth activity failed: {error}");
        }
    }
}

pub(super) fn watch(app: AppHandle) {
    if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        eprintln!("Bluetooth WinRT initialization failed: {error}");
        return;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _apartment = Apartment;
    loop {
        if let Err(error) = watch_session(&app) {
            eprintln!("Bluetooth watcher stopped: {error}");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn create_watcher() -> windows::core::Result<DeviceWatcher> {
    let properties: IIterable<HSTRING> = vec![CONNECTED, CONTAINER, ADDRESS, NAME, BATTERY]
        .into_iter()
        .map(HSTRING::from)
        .collect::<Vec<_>>()
        .try_into()?;
    DeviceInformation::CreateWatcherWithKindAqsFilterAndAdditionalProperties(
        &HSTRING::from(SELECTOR),
        &properties,
        DeviceInformationKind::AssociationEndpoint,
    )
}

fn watch_session(app: &AppHandle) -> windows::core::Result<()> {
    let watcher = create_watcher()?;
    let (tx, rx) = mpsc::channel();
    let sender = tx.clone();
    let added = watcher.Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
        move |_, device| {
            if let Some(device) = device {
                let mut change = patch(&device.Properties()?);
                change.name = Some(device.Name()?.to_string_lossy());
                let _ = sender.send(Message::Added(device.Id()?.to_string_lossy(), change));
            }
            Ok(())
        },
    ))?;
    let sender = tx.clone();
    let updated = watcher.Updated(
        &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, device| {
            if let Some(device) = device {
                let _ = sender.send(Message::Updated(
                    device.Id()?.to_string_lossy(),
                    patch(&device.Properties()?),
                ));
            }
            Ok(())
        }),
    )?;
    let sender = tx.clone();
    let removed = watcher.Removed(
        &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, device| {
            if let Some(device) = device {
                let _ = sender.send(Message::Removed(device.Id()?.to_string_lossy()));
            }
            Ok(())
        }),
    )?;
    let sender = tx.clone();
    let seeded = watcher.EnumerationCompleted(
        &TypedEventHandler::<DeviceWatcher, IInspectable>::new(move |_, _| {
            let _ = sender.send(Message::Seed);
            Ok(())
        }),
    )?;
    let sender = tx.clone();
    let stopped = watcher.Stopped(&TypedEventHandler::<DeviceWatcher, IInspectable>::new(
        move |_, _| {
            let _ = sender.send(Message::Stopped);
            Ok(())
        },
    ))?;

    // One worker, at most one outstanding cache read, never a GATT operation.
    let (battery_tx, battery_rx) = mpsc::sync_channel::<Vec<Live>>(1);
    let battery_sender = tx.clone();
    let _ = std::thread::Builder::new()
        .name("bluetooth-battery".into())
        .spawn(move || {
            while let Ok(devices) = battery_rx.recv() {
                if battery_sender
                    .send(Message::Battery(cached_batteries(&devices)))
                    .is_err()
                {
                    break;
                }
            }
        });
    let result = (|| {
        watcher.Start()?;
        let mut tracker = Tracker::default();
        let mut querying = false;
        let mut last_query: Option<Instant> = None;
        loop {
            let changes = match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(Message::Added(id, patch) | Message::Updated(id, patch)) => {
                    tracker.update(id, patch)
                }
                Ok(Message::Removed(id)) => tracker.remove(&id),
                Ok(Message::Seed) => {
                    tracker.seed();
                    Vec::new()
                }
                Ok(Message::Stopped) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    // With no live observer, do not leave a queued success based
                    // on an old connection snapshot. Cancellation is silent.
                    publish(
                        app,
                        tracker
                            .live
                            .iter()
                            .map(|live| live.event("bluetooth-disconnected"))
                            .collect(),
                    );
                    break;
                }
                Ok(Message::Battery(levels)) => {
                    querying = false;
                    levels
                        .into_iter()
                        .filter_map(|(token, level)| tracker.battery(&token, level))
                        .collect()
                }
                Err(mpsc::RecvTimeoutError::Timeout) => Vec::new(),
            };
            if changes
                .iter()
                .any(|change| change.kind == "bluetooth-connected")
            {
                last_query = None;
            }
            publish(app, changes);
            if tracker.seeded
                && !tracker.live.is_empty()
                && !querying
                && last_query.is_none_or(|at| at.elapsed() >= Duration::from_secs(4))
                && battery_tx.try_send(tracker.live.clone()).is_ok()
            {
                querying = true;
                last_query = Some(Instant::now());
            }
        }
        Ok(())
    })();
    let _ = watcher.Stop();
    let _ = watcher.RemoveAdded(added);
    let _ = watcher.RemoveUpdated(updated);
    let _ = watcher.RemoveRemoved(removed);
    let _ = watcher.RemoveEnumerationCompleted(seeded);
    let _ = watcher.RemoveStopped(stopped);
    result
}

/// Read only Windows' cached device property (the same value exposed by Device
/// Settings). Missing, invalid, or conflicting component levels stay unknown.
fn cached_batteries(devices: &[Live]) -> Vec<(String, u8)> {
    const LEVEL: DEVPROPKEY = DEVPROPKEY {
        fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5),
        pid: 2,
    };
    let mut levels: HashMap<String, HashSet<u8>> = HashMap::new();
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(
            None,
            PCWSTR::null(),
            HWND::default(),
            DIGCF_PRESENT | DIGCF_ALLCLASSES,
        ) else {
            return Vec::new();
        };
        let mut index = 0;
        loop {
            let mut info = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if let Err(error) = SetupDiEnumDeviceInfo(set, index, &mut info) {
                if error.code() != HRESULT::from_win32(ERROR_NO_MORE_ITEMS.0) {
                    levels.clear();
                }
                break;
            }
            index += 1;
            let mut kind = DEVPROPTYPE::default();
            let mut bytes = [0u8; 4];
            if SetupDiGetDevicePropertyW(set, &info, &LEVEL, &mut kind, Some(&mut bytes), None, 0)
                .is_err()
            {
                continue;
            }
            let level = if kind == DEVPROP_TYPE_BYTE {
                u32::from(bytes[0])
            } else if kind == DEVPROP_TYPE_UINT16 {
                u32::from(u16::from_le_bytes([bytes[0], bytes[1]]))
            } else if kind == DEVPROP_TYPE_UINT32 {
                u32::from_le_bytes(bytes)
            } else {
                continue;
            };
            if level > 100 {
                continue;
            }
            let mut aliases = HashSet::new();
            let mut node = info.DevInst;
            for _ in 0..16 {
                let mut id = [0u16; 512];
                if CM_Get_Device_IDW(node, &mut id, 0) != CR_SUCCESS {
                    break;
                }
                let id = wide_to_string(&id).to_ascii_uppercase();
                if !id.starts_with("BTH") && !id.starts_with("HID\\") {
                    break;
                }
                if let Some(at) = id.find("DEV_")
                    && let Some(addr) = id.get(at + 4..at + 16).and_then(address)
                {
                    aliases.insert(format!("address:{addr}"));
                }
                // The property belongs to this node; its container is generally
                // shared by all HID/audio functions of the physical device.
                if node == info.DevInst {
                    let mut kind = DEVPROPTYPE::default();
                    let mut guid = [0u8; 16];
                    if SetupDiGetDevicePropertyW(
                        set,
                        &info,
                        &DEVPKEY_Device_ContainerId,
                        &mut kind,
                        Some(&mut guid),
                        None,
                        0,
                    )
                    .is_ok()
                        && kind == DEVPROP_TYPE_GUID
                        && let Some(id) =
                            container(std::ptr::read_unaligned(guid.as_ptr().cast::<GUID>()))
                    {
                        aliases.insert(format!("container:{id}"));
                    }
                }
                let mut parent = 0;
                if CM_Get_Parent(&mut parent, node, 0) != CR_SUCCESS {
                    break;
                }
                node = parent;
            }
            for device in devices {
                if !device.aliases.is_disjoint(&aliases) {
                    levels
                        .entry(device.token.clone())
                        .or_default()
                        .insert(level as u8);
                }
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    levels
        .into_iter()
        .filter_map(|(token, values)| {
            (values.len() == 1).then(|| (token, *values.iter().next().unwrap()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(name: &str, connected: bool, container: &str, address: &str) -> Patch {
        Patch {
            name: Some(name.into()),
            connected: Some(connected),
            container: (!container.is_empty()).then(|| container.into()),
            address: (!address.is_empty()).then(|| address.into()),
            battery: None,
        }
    }

    #[test]
    fn startup_and_adapter_visibility_are_not_connections() {
        let mut state = Tracker::default();
        assert!(
            state
                .update("existing".into(), endpoint("Headset", true, "one", ""))
                .is_empty()
        );
        state.seed();
        assert_eq!(state.live.len(), 1);
        assert!(
            state
                .update("nearby".into(), endpoint("Nearby mouse", false, "two", ""))
                .is_empty()
        );
        assert!(
            state
                .update(
                    "nearby".into(),
                    Patch {
                        name: Some("Renamed nearby mouse".into()),
                        ..Default::default()
                    }
                )
                .is_empty()
        );
        let changes = state.update(
            "nearby".into(),
            Patch {
                connected: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "bluetooth-connected");
    }

    #[test]
    fn classic_and_ble_share_a_single_connection() {
        let mut state = Tracker::default();
        state.seed();
        let first = state.update(
            "classic".into(),
            endpoint("Headset", true, "one", "001122334455"),
        );
        let token = first[0].payload.device_id.clone();
        let second = state.update(
            "ble".into(),
            endpoint("Headset", true, "one", "aabbccddeeff"),
        );
        assert!(second.is_empty());
        assert_eq!(state.live.len(), 1);
        assert!(
            state.remove("classic").is_empty(),
            "one endpoint is still connected"
        );
        let last = state.remove("ble");
        assert_eq!(last[0].kind, "bluetooth-disconnected");
        assert_eq!(last[0].payload.device_id, token);
    }

    #[test]
    fn matching_address_also_deduplicates_transports() {
        let mut state = Tracker::default();
        state.seed();
        state.update(
            "classic".into(),
            endpoint("Headset", true, "container-a", "001122334455"),
        );
        assert!(
            state
                .update(
                    "ble".into(),
                    endpoint("Headset", true, "container-b", "001122334455")
                )
                .is_empty()
        );
        assert_eq!(state.live.len(), 1);
    }

    #[test]
    fn equal_names_are_not_an_identity() {
        let mut state = Tracker::default();
        state.seed();
        let first = state.update("a".into(), endpoint("AirPods Pro", true, "one", ""));
        let second = state.update("b".into(), endpoint("AirPods Pro", true, "two", ""));
        assert_eq!(state.live.len(), 2);
        assert_ne!(first[0].payload.device_id, second[0].payload.device_id);
    }

    #[test]
    fn partial_updates_do_not_erase_connection_and_battery_does_not_reconnect() {
        let mut state = Tracker::default();
        state.seed();
        let first = state.update("a".into(), endpoint("Mouse", true, "", "001122334455"));
        let token = &first[0].payload.device_id;
        assert!(
            state
                .update(
                    "a".into(),
                    Patch {
                        container: Some("learned".into()),
                        ..Default::default()
                    }
                )
                .is_empty()
        );
        let battery = state.battery(token, 85).unwrap();
        assert_eq!(battery.kind, "bluetooth-updated");
        assert_eq!(battery.payload.battery_percent, Some(85));
        assert!(state.battery(token, 85).is_none());
        assert!(state.update("a".into(), Patch::default()).is_empty());
        let name = state.update(
            "a".into(),
            Patch {
                name: Some("New name".into()),
                ..Default::default()
            },
        );
        assert_eq!(name[0].kind, "bluetooth-updated");
        assert_eq!(name[0].payload.device_id, *token);
        assert_eq!(name[0].payload.battery_percent, Some(85));
    }

    #[test]
    fn reconnect_has_a_fresh_token_and_discards_old_battery_reply() {
        let mut state = Tracker::default();
        state.seed();
        let first = state.update("a".into(), endpoint("Mouse", true, "one", ""));
        let old = first[0].payload.device_id.clone();
        let removed = state.update(
            "a".into(),
            Patch {
                connected: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(removed[0].kind, "bluetooth-disconnected");
        let new = state.update(
            "a".into(),
            Patch {
                connected: Some(true),
                ..Default::default()
            },
        );
        assert_ne!(new[0].payload.device_id, old);
        assert!(state.battery(&old, 85).is_none());
    }

    #[test]
    fn addresses_and_battery_values_are_validated() {
        assert_eq!(address("AA:BB:CC:DD:EE:FF"), Some("aabbccddeeff".into()));
        assert!(address("000000000000").is_none());
        assert!(address("not-a-device").is_none());
        let mut state = Tracker::default();
        state.seed();
        let first = state.update("a".into(), endpoint("Mouse", true, "one", ""));
        let token = &first[0].payload.device_id;
        assert!(state.battery(token, 255).is_none());
        assert_eq!(
            state.battery(token, 0).unwrap().payload.battery_percent,
            Some(0)
        );
    }

    #[test]
    #[ignore = "manual passive Windows Classic/BLE watcher probe (6 seconds, no desktop app)"]
    fn bluetooth_windows_inventory() {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        let watcher = create_watcher().expect("create Classic + BLE watcher");
        let (tx, rx) = mpsc::channel();
        let sender = tx.clone();
        let added = watcher
            .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
                move |_, device| {
                    if let Some(device) = device {
                        let mut p = patch(&device.Properties()?);
                        p.name = Some(device.Name()?.to_string_lossy());
                        let _ = sender.send((device.Id()?.to_string_lossy(), p));
                    }
                    Ok(())
                },
            ))
            .unwrap();
        let updated = watcher.Updated(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, device| {
            if let Some(device) = device { let _ = tx.send((device.Id()?.to_string_lossy(), patch(&device.Properties()?))); }
            Ok(())
        })).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let completed = watcher.EnumerationCompleted(&TypedEventHandler::<DeviceWatcher, IInspectable>::new(move |_, _| {
            let _ = done_tx.send(()); Ok(())
        })).unwrap();
        watcher.Start().expect("start passive watcher");
        let seconds = std::env::var("NOTCH_BT_PROBE_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(6);
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut enumerated = false;
        let mut state = Tracker::default();
        while Instant::now() < deadline {
            if let Ok((id, p)) = rx.recv_timeout(Duration::from_millis(100)) {
                println!(
                    "device={} connected={:?} container={} address={}",
                    p.name.as_deref().unwrap_or(""),
                    p.connected,
                    p.container.is_some(),
                    p.address.is_some()
                );
                state.update(id, p);
            }
            if done_rx.try_recv().is_ok() {
                enumerated = true;
                // All preceding Added messages were queued before completion.
                while let Ok((id, p)) = rx.try_recv() { state.update(id, p); }
                break;
            }
        }
        watcher.Stop().unwrap();
        watcher.RemoveAdded(added).unwrap();
        watcher.RemoveUpdated(updated).unwrap();
        watcher.RemoveEnumerationCompleted(completed).unwrap();
        state.seed();
        for (token, level) in cached_batteries(&state.live) {
            println!("{token} battery={level}%");
        }
        println!(
            "{} endpoints, {} connected physical devices; enumeration complete={enumerated}",
            state.endpoints.len(),
            state.live.len()
        );
        drop(watcher);
        unsafe {
            RoUninitialize();
        }
    }
}
