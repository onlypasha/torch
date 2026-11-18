//! Windows' current notification inbox. Contents stay in memory and are never
//! logged or persisted. Windows remains the authority for additions, updates,
//! removals and permission changes; there is no independent notification history.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use windows::{
    ApplicationModel::{AppInfo, Package},
    Foundation::{IAsyncOperation, Size},
    Storage::Streams::DataReader,
    UI::Notifications::{
        KnownNotificationBindings,
        Management::{UserNotificationListener, UserNotificationListenerAccessStatus},
        NotificationKinds, UserNotification,
    },
    Win32::{
        Foundation::HWND,
        System::{
            Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        },
        UI::{
            Shell::{
                AO_NONE, ApplicationActivationManager, IApplicationActivationManager, ShellExecuteW,
            },
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
    core::{HSTRING, PCWSTR, w},
};

const EVENT: &str = "notifications-state";
const LIMIT: usize = 100;
const POLL: Duration = Duration::from_secs(2);
const IDENTITY_MESSAGE: &str = "Akses notifikasi memerlukan NotchApp yang terdaftar di Windows dengan izin notifikasi. Jalankan versi aplikasi yang sudah terdaftar.";
const DENIED_MESSAGE: &str = "Akses notifikasi belum diizinkan. Aktifkan akses NotchApp di pengaturan privasi notifikasi Windows.";
#[path = "notification_avatar.rs"]
mod avatar;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct AvatarKey {
    id: u32,
    app_id: String,
    created_at_ms: u64,
}
impl AvatarKey {
    fn of(item: &Item) -> Self {
        Self {
            id: item.id,
            app_id: item.app_id.clone(),
            created_at_ms: item.created_at_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Unknown,
    Allowed,
    Denied,
    Unsupported,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u32,
    pub app_id: String,
    pub app_name: String,
    pub title: String,
    pub body: String,
    pub created_at_ms: u64,
    pub icon: Option<Arc<str>>,
    pub avatar: Option<Arc<str>>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub access: Access,
    pub message: String,
    pub items: Vec<Item>,
    pub updated_at_ms: u64,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            access: Access::Unknown,
            message: String::new(),
            items: vec![],
            updated_at_ms: 0,
        }
    }
}

enum Read {
    Allowed(Vec<Item>),
    Blocked(Access, String),
    Failed(String),
}
impl Snapshot {
    /// A failed read retains the last known inbox with an explicit error.
    /// Permission revocation instead erases content immediately.
    fn reconcile(&mut self, result: Read) -> bool {
        let changed;
        match result {
            Read::Allowed(mut items) => {
                items.sort_by(|a, b| {
                    b.created_at_ms
                        .cmp(&a.created_at_ms)
                        .then_with(|| b.id.cmp(&a.id))
                });
                let mut seen = HashSet::new();
                items.retain(|item| seen.insert(item.id));
                items.truncate(LIMIT);
                changed = self.access != Access::Allowed
                    || !self.message.is_empty()
                    || self.items != items;
                self.items = items;
                self.access = Access::Allowed;
                self.message.clear();
                self.updated_at_ms = now_ms();
            }
            Read::Blocked(access, message) => {
                changed =
                    self.access != access || self.message != message || !self.items.is_empty();
                self.access = access;
                self.message = message;
                self.items.clear();
                self.updated_at_ms = 0;
            }
            Read::Failed(message) => {
                changed = self.access != Access::Error || self.message != message;
                self.access = Access::Error;
                self.message = message;
            }
        }
        if changed {
            self.revision = self.revision.saturating_add(1);
        }
        changed
    }
}

type Reply = oneshot::Sender<Result<Snapshot, String>>;
enum Command {
    Refresh(Reply),
    Permission(IAsyncOperation<UserNotificationListenerAccessStatus>, Reply),
    PermissionError(windows::core::Error, Reply),
    Dismiss(Vec<u32>, Reply),
    Open(u32, oneshot::Sender<Result<(), String>>),
    AvatarReady(AvatarKey, Option<String>),
    Stop,
}

pub struct Store {
    state: Arc<Mutex<Snapshot>>,
    sender: mpsc::Sender<Command>,
}
impl Store {
    fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    async fn ask(&self, command: impl FnOnce(Reply) -> Command) -> Result<Snapshot, String> {
        let (reply, result) = oneshot::channel();
        self.sender
            .send(command(reply))
            .map_err(|_| "Layanan notifikasi tidak terhubung")?;
        result.await.map_err(|_| "Layanan notifikasi terhenti")?
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        let _ = self.sender.send(Command::Stop);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn date_ms(ticks: i64) -> u64 {
    ticks.saturating_sub(116_444_736_000_000_000).max(0) as u64 / 10_000
}
fn text(value: HSTRING, limit: usize) -> String {
    value
        .to_string_lossy()
        .chars()
        .filter(|c| !c.is_control() || matches!(*c, '\n' | '\t'))
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn failure(error: windows::core::Error, action: &str) -> String {
    format!(
        "{action} (0x{:08X}). Coba muat ulang.",
        error.code().0 as u32
    )
}
fn blocked(status: UserNotificationListenerAccessStatus) -> Option<Read> {
    match status {
        UserNotificationListenerAccessStatus::Allowed => None,
        UserNotificationListenerAccessStatus::Denied => {
            Some(Read::Blocked(Access::Denied, DENIED_MESSAGE.into()))
        }
        _ => Some(Read::Blocked(
            Access::Unknown,
            "Izinkan NotchApp membaca notifikasi Windows untuk menampilkannya di sini.".into(),
        )),
    }
}
fn permission_error(error: windows::core::Error) -> Read {
    if Package::Current().is_err() {
        Read::Blocked(Access::Unsupported, IDENTITY_MESSAGE.into())
    } else if error.code().0 as u32 == 0x80070005 {
        Read::Blocked(Access::Denied, DENIED_MESSAGE.into())
    } else if matches!(error.code().0 as u32, 0x80040154 | 0x80004001) {
        Read::Blocked(
            Access::Unsupported,
            "Windows pada perangkat ini belum mendukung pembaca notifikasi.".into(),
        )
    } else {
        Read::Failed(failure(error, "Akses notifikasi tidak dapat diperiksa"))
    }
}

struct Reader {
    listener: Option<UserNotificationListener>,
    icons: HashMap<String, Option<Arc<str>>>,
    avatars: HashMap<AvatarKey, (Option<Arc<str>>, Instant)>,
    avatar_pending: HashSet<AvatarKey>,
    sender: mpsc::Sender<Command>,
}
fn reserve_avatar(pending: &mut HashSet<AvatarKey>, key: &AvatarKey) -> bool {
    pending.len() < 4 && pending.insert(key.clone())
}
impl Reader {
    fn new(sender: mpsc::Sender<Command>) -> Self {
        Self {
            listener: None,
            icons: HashMap::new(),
            avatars: HashMap::new(),
            avatar_pending: HashSet::new(),
            sender,
        }
    }
    fn clear_private_images(&mut self) {
        self.avatars.clear();
        // Running jobs still occupy slots until their completion arrives.
    }
    fn schedule_avatars(&mut self, items: &[Item]) {
        // Only the newest sixteen WhatsApp toasts are candidates. Images stay
        // in memory for the lifetime of their matching Windows notifications.
        let keys = items
            .iter()
            .filter(|item| item.created_at_ms > 0 && item.app_id.contains("WhatsAppDesktop"))
            .take(16)
            .map(AvatarKey::of)
            .collect::<HashSet<_>>();
        self.avatars.retain(|key, _| keys.contains(key));
        for key in keys {
            if self.avatar_pending.len() >= 4 {
                break;
            }
            if self.avatars.get(&key).is_some_and(|(image, checked)| {
                image.is_some() || checked.elapsed() < Duration::from_secs(60)
            }) {
                continue;
            }
            if !reserve_avatar(&mut self.avatar_pending, &key) {
                continue;
            }
            let sender = self.sender.clone();
            std::thread::spawn(move || {
                let image = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()
                    .and_then(|runtime| {
                        runtime.block_on(avatar::resolve(key.id, &key.app_id, key.created_at_ms))
                    });
                let _ = sender.send(Command::AvatarReady(key, image));
            });
        }
    }
    fn listener(&mut self) -> windows::core::Result<&UserNotificationListener> {
        if self.listener.is_none() {
            self.listener = Some(UserNotificationListener::Current()?);
        }
        Ok(self.listener.as_ref().unwrap())
    }
    fn read(&mut self) -> Read {
        let listener = match self.listener() {
            Ok(listener) => listener.clone(),
            Err(error) => return permission_error(error),
        };
        match listener.GetAccessStatus() {
            Ok(status) => {
                if let Some(result) = blocked(status) {
                    self.icons.clear();
                    self.clear_private_images();
                    return if Package::Current().is_err() {
                        Read::Blocked(Access::Unsupported, IDENTITY_MESSAGE.into())
                    } else {
                        result
                    };
                }
            }
            Err(error) => return permission_error(error),
        }
        let notifications = match listener
            .GetNotificationsAsync(NotificationKinds::Toast)
            .and_then(|operation| operation.get())
        {
            Ok(notifications) => notifications,
            Err(error) => {
                // A revoked capability can make an in-flight read fail instead
                // of returning an empty vector. Recheck before retaining data.
                match listener.GetAccessStatus() {
                    Ok(status) => {
                        if let Some(result) = blocked(status) {
                            self.icons.clear();
                            self.clear_private_images();
                            return result;
                        }
                    }
                    Err(access_error) => return permission_error(access_error),
                }
                return Read::Failed(failure(error, "Notifikasi Windows tidak dapat dibaca"));
            }
        };
        // Permission may have changed while the asynchronous read was pending.
        match listener.GetAccessStatus() {
            Ok(status) => {
                if let Some(result) = blocked(status) {
                    self.icons.clear();
                    self.clear_private_images();
                    return result;
                }
            }
            Err(error) => return permission_error(error),
        }
        let mut ordered = notifications
            .into_iter()
            .map(|notification| {
                let time = notification
                    .CreationTime()
                    .map(|time| date_ms(time.UniversalTime))
                    .unwrap_or(0);
                (time, notification)
            })
            .collect::<Vec<_>>();
        ordered.sort_by(|a, b| b.0.cmp(&a.0));
        let mut items = Vec::new();
        for (created_at_ms, notification) in ordered.into_iter().take(LIMIT) {
            if let Ok(item) = self.item(notification, created_at_ms) {
                items.push(item);
            }
        }
        self.icons
            .retain(|app_id, _| items.iter().any(|item| &item.app_id == app_id));
        self.schedule_avatars(&items);
        Read::Allowed(items)
    }
    fn item(
        &mut self,
        notification: UserNotification,
        created_at_ms: u64,
    ) -> windows::core::Result<Item> {
        let id = notification.Id()?;
        let binding = notification
            .Notification()?
            .Visual()?
            .GetBinding(&KnownNotificationBindings::ToastGeneric()?)?;
        let mut texts = binding
            .GetTextElements()?
            .into_iter()
            .take(32)
            .filter_map(|element| element.Text().ok())
            .map(|value| text(value, 4096))
            .filter(|value| !value.is_empty());
        let title = texts.next().unwrap_or_default().chars().take(512).collect();
        let body = texts
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(4096)
            .collect();
        let info = notification.AppInfo().ok();
        let app_id = info
            .as_ref()
            .and_then(|info| info.AppUserModelId().ok())
            .map(|v| text(v, 1024))
            .unwrap_or_default();
        let app_name = info
            .as_ref()
            .and_then(|info| info.DisplayInfo().ok())
            .and_then(|info| info.DisplayName().ok())
            .map(|v| text(v, 256))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Windows".into());
        let icon = info.as_ref().and_then(|info| {
            if app_id.is_empty() {
                return None;
            }
            if let Some(icon) = self.icons.get(&app_id) {
                return icon.clone();
            }
            let icon = app_icon(info).map(Arc::<str>::from);
            if self.icons.len() >= 64 {
                self.icons.clear();
            }
            self.icons.insert(app_id.clone(), icon.clone());
            icon
        });
        let avatar = self
            .avatars
            .get(&AvatarKey {
                id,
                app_id: app_id.clone(),
                created_at_ms,
            })
            .and_then(|(image, _)| image.clone());
        Ok(Item {
            id,
            app_id,
            app_name,
            title,
            body,
            created_at_ms,
            icon,
            avatar,
        })
    }
    fn allowed(&mut self) -> Result<UserNotificationListener, String> {
        let listener = self
            .listener()
            .map_err(|_| "Akses notifikasi belum tersedia")?
            .clone();
        if listener
            .GetAccessStatus()
            .map_err(|_| "Akses notifikasi tidak dapat diperiksa")?
            != UserNotificationListenerAccessStatus::Allowed
        {
            return Err(DENIED_MESSAGE.into());
        }
        Ok(listener)
    }
    fn dismiss(&mut self, snapshot: &Snapshot, ids: Vec<u32>) -> Result<(), String> {
        let targets = displayed_targets(snapshot, ids)?;
        let listener = self.allowed()?;
        let mut failed = false;
        for (id, creation) in targets {
            match listener.GetNotification(id) {
                Ok(current) => {
                    // IDs may be reused. Do not dismiss a newly created toast
                    // that replaced the one shown when the user clicked.
                    if current
                        .CreationTime()
                        .map(|v| date_ms(v.UniversalTime))
                        .ok()
                        != Some(creation)
                    {
                        failed = true;
                        continue;
                    }
                    if self.allowed()?.RemoveNotification(id).is_err() {
                        failed = true;
                    }
                }
                Err(error) if matches!(error.code().0 as u32, 0x80070490 | 0x80070057) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            Err("Sebagian notifikasi tidak dapat dihapus. Daftar sudah dimuat ulang.".into())
        } else {
            Ok(())
        }
    }
    fn open(&mut self, snapshot: &Snapshot, id: u32) -> Result<(), String> {
        let item = snapshot
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or("Notifikasi sudah tidak tersedia")?;
        let listener = self.allowed()?;
        let notification = listener
            .GetNotification(id)
            .map_err(|_| "Notifikasi sudah tidak tersedia")?;
        let app_id = notification
            .AppInfo()
            .and_then(|info| info.AppUserModelId())
            .map_err(|_| "Aplikasi pengirim tidak dapat dibuka")?;
        if app_id.is_empty() || app_id.to_string_lossy() != item.app_id {
            return Err("Aplikasi pengirim tidak dapat dibuka".into());
        }
        let wide = app_id
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        unsafe {
            let activation: IApplicationActivationManager =
                CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| "Windows tidak dapat membuka aplikasi pengirim")?;
            activation.ActivateApplication(PCWSTR(wide.as_ptr()), w!(""), AO_NONE)
                .map_err(|_| "Aplikasi pengirim tidak dapat dibuka. Gunakan pusat notifikasi Windows untuk tindakan asli pesan.")?;
        }
        // Opening an app is not equivalent to invoking its original toast action.
        // Leave the notification in Windows until explicitly dismissed.
        Ok(())
    }
}

fn displayed_targets(snapshot: &Snapshot, ids: Vec<u32>) -> Result<Vec<(u32, u64)>, String> {
    if ids.is_empty() || ids.len() > LIMIT {
        return Err("Pilih notifikasi yang ditampilkan".into());
    }
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(*id))
        .map(|id| {
            snapshot
                .items
                .iter()
                .find(|item| item.id == id)
                .map(|item| (id, item.created_at_ms))
                .ok_or_else(|| {
                    "Notifikasi sudah berubah. Muat ulang daftar sebelum menghapus.".into()
                })
        })
        .collect()
}

fn app_icon(info: &AppInfo) -> Option<String> {
    let stream = info
        .DisplayInfo()
        .ok()?
        .GetLogo(Size {
            Width: 32.0,
            Height: 32.0,
        })
        .ok()?
        .OpenReadAsync()
        .ok()?
        .get()
        .ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 256 * 1024 {
        return None;
    }
    let mime = stream.ContentType().ok()?.to_string_lossy();
    if !matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/bmp" | "image/x-icon" | "image/vnd.microsoft.icon"
    ) {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    if reader.LoadAsync(size as u32).ok()?.get().ok()? != size as u32 {
        return None;
    }
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(value >> 18 & 63) as usize] as char);
        out.push(TABLE[(value >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(value >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn publish(state: &Arc<Mutex<Snapshot>>, app: &AppHandle, result: Read) -> Snapshot {
    let mut snapshot = state.lock().unwrap_or_else(|e| e.into_inner());
    if snapshot.reconcile(result) {
        let _ = app.emit(EVENT, &*snapshot);
    }
    snapshot.clone()
}
struct Apartment;
impl Apartment {
    fn init() -> windows::core::Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

pub fn install(app: AppHandle) -> Store {
    let state = Arc::new(Mutex::new(Snapshot::default()));
    let (sender, receiver) = mpsc::channel();
    let worker_sender = sender.clone();
    let worker_state = state.clone();
    std::thread::spawn(move || {
        let _apartment = match Apartment::init() {
            Ok(apartment) => apartment,
            Err(error) => {
                publish(
                    &worker_state,
                    &app,
                    Read::Failed(failure(error, "Layanan notifikasi gagal dimulai")),
                );
                return;
            }
        };
        let mut reader = Reader::new(worker_sender);
        publish(&worker_state, &app, reader.read());
        loop {
            match receiver.recv_timeout(POLL) {
                Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    publish(&worker_state, &app, reader.read());
                }
                Ok(Command::Refresh(reply)) => {
                    let _ = reply.send(Ok(publish(&worker_state, &app, reader.read())));
                }
                Ok(Command::Permission(operation, reply)) => match operation.get() {
                    Ok(_) => {
                        let _ = reply.send(Ok(publish(&worker_state, &app, reader.read())));
                    }
                    Err(error) => {
                        let _ =
                            reply.send(Ok(publish(&worker_state, &app, permission_error(error))));
                    }
                },
                Ok(Command::PermissionError(error, reply)) => {
                    let _ = reply.send(Ok(publish(&worker_state, &app, permission_error(error))));
                }
                Ok(Command::Dismiss(ids, reply)) => {
                    let previous = worker_state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    let result = reader.dismiss(&previous, ids);
                    let snapshot = publish(&worker_state, &app, reader.read());
                    let _ = reply.send(result.map(|()| snapshot));
                }
                Ok(Command::Open(id, reply)) => {
                    let previous = worker_state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    let result = reader.open(&previous, id);
                    publish(&worker_state, &app, reader.read());
                    let _ = reply.send(result);
                }
                Ok(Command::AvatarReady(key, image)) => {
                    reader.avatar_pending.remove(&key);
                    let previous = worker_state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    if previous.access == Access::Allowed
                        && previous.items.iter().any(|item| AvatarKey::of(item) == key)
                    {
                        if reader.allowed().is_ok() {
                            reader
                                .avatars
                                .insert(key, (image.map(Arc::<str>::from), Instant::now()));
                        }
                        publish(&worker_state, &app, reader.read());
                    }
                }
            }
        }
    });
    Store { state, sender }
}

#[tauri::command]
pub fn notifications_snapshot(store: State<'_, Store>) -> Snapshot {
    store.snapshot()
}
#[tauri::command]
pub async fn notifications_refresh(store: State<'_, Store>) -> Result<Snapshot, String> {
    store.ask(Command::Refresh).await
}
#[tauri::command]
pub async fn notifications_request_access(
    app: AppHandle,
    store: State<'_, Store>,
) -> Result<Snapshot, String> {
    let (reply, result) = oneshot::channel();
    let sender = store.sender.clone();
    // Microsoft requires RequestAccessAsync to be *called* on a UI thread.
    // Its operation is awaited by the worker, never synchronously on that thread.
    app.run_on_main_thread(move || {
        let command = match UserNotificationListener::Current()
            .and_then(|listener| listener.RequestAccessAsync())
        {
            Ok(operation) => Command::Permission(operation, reply),
            Err(error) => Command::PermissionError(error, reply),
        };
        let _ = sender.send(command);
    })
    .map_err(|_| "Permintaan akses notifikasi tidak dapat ditampilkan")?;
    result.await.map_err(|_| "Layanan notifikasi terhenti")?
}
#[tauri::command]
pub async fn notifications_dismiss(id: u32, store: State<'_, Store>) -> Result<Snapshot, String> {
    store.ask(|reply| Command::Dismiss(vec![id], reply)).await
}
#[tauri::command]
pub async fn notifications_clear(
    ids: Vec<u32>,
    store: State<'_, Store>,
) -> Result<Snapshot, String> {
    store.ask(|reply| Command::Dismiss(ids, reply)).await
}
#[tauri::command]
pub async fn notifications_open(id: u32, store: State<'_, Store>) -> Result<(), String> {
    let (reply, result) = oneshot::channel();
    store
        .sender
        .send(Command::Open(id, reply))
        .map_err(|_| "Layanan notifikasi tidak terhubung")?;
    result.await.map_err(|_| "Layanan notifikasi terhenti")?
}
#[tauri::command]
pub fn notifications_settings() -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            w!("open"),
            w!("ms-settings:privacy-notifications"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as usize <= 32 {
        Err("Pengaturan notifikasi Windows tidak dapat dibuka".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn avatar_jobs_are_deduplicated_and_bounded_until_completion() {
        let mut pending = HashSet::new();
        let first = AvatarKey::of(&item(1, 10, ""));
        assert!(reserve_avatar(&mut pending, &first));
        for _ in 0..100 {
            assert!(!reserve_avatar(&mut pending, &first));
        }
        for id in 2..=4 {
            assert!(reserve_avatar(
                &mut pending,
                &AvatarKey::of(&item(id, 10, ""))
            ));
        }
        let next = AvatarKey::of(&item(5, 10, ""));
        assert!(!reserve_avatar(&mut pending, &next));
        pending.remove(&first);
        assert!(reserve_avatar(&mut pending, &next));
    }
    #[test]
    fn removed_toasts_and_permission_revocation_do_not_free_running_job_slots() {
        let (sender, _) = mpsc::channel();
        let mut reader = Reader::new(sender);
        for id in 1..=4 {
            reader
                .avatar_pending
                .insert(AvatarKey::of(&item(id, 10, "")));
        }
        reader.clear_private_images();
        reader.schedule_avatars(&[]);
        assert_eq!(reader.avatar_pending.len(), 4);
        assert!(!reserve_avatar(
            &mut reader.avatar_pending,
            &AvatarKey::of(&item(5, 10, ""))
        ));
    }
    #[test]
    fn snapshots_share_image_buffers_and_identical_polls_do_not_emit() {
        let mut entry = item(1, 10, "");
        entry.avatar = Some(Arc::from("x".repeat(1024 * 1024)));
        let copy = entry.clone();
        assert!(Arc::ptr_eq(
            entry.avatar.as_ref().unwrap(),
            copy.avatar.as_ref().unwrap()
        ));
        let mut state = Snapshot::default();
        assert!(state.reconcile(Read::Allowed(vec![entry])));
        let revision = state.revision;
        assert!(!state.reconcile(Read::Allowed(vec![copy])));
        assert_eq!(state.revision, revision);
    }
    fn item(id: u32, time: u64, body: &str) -> Item {
        Item {
            id,
            app_id: "test.app".into(),
            app_name: "Test".into(),
            title: "Test".into(),
            body: body.into(),
            created_at_ms: time,
            icon: None,
            avatar: None,
        }
    }
    #[test]
    fn live_inbox_replaces_same_id_content_and_removes_closed_notifications() {
        let mut state = Snapshot::default();
        assert!(state.reconcile(Read::Allowed(vec![
            item(1, 10, "old"),
            item(2, 20, "other")
        ])));
        assert!(state.reconcile(Read::Allowed(vec![item(1, 10, "updated")])));
        assert_eq!(state.items, vec![item(1, 10, "updated")]);
        assert_eq!(state.revision, 2);
        assert!(!state.reconcile(Read::Allowed(vec![item(1, 10, "updated")])));
    }
    #[test]
    fn newest_first_deduplicates_and_bounds_large_inbox() {
        let mut state = Snapshot::default();
        let mut items = (0..130)
            .map(|id| item(id, id.into(), "message"))
            .collect::<Vec<_>>();
        items.push(item(129, 129, "duplicate"));
        state.reconcile(Read::Allowed(items));
        assert_eq!(state.items.len(), 100);
        assert_eq!(state.items.first().unwrap().id, 129);
        assert_eq!(state.items.last().unwrap().id, 30);
    }
    #[test]
    fn failed_reads_preserve_last_known_inbox_and_recovery_clears_error() {
        let mut state = Snapshot::default();
        state.reconcile(Read::Allowed(vec![item(1, 10, "message")]));
        let last_read = state.updated_at_ms;
        state.reconcile(Read::Failed("Unavailable".into()));
        assert_eq!(state.access, Access::Error);
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.updated_at_ms, last_read);
        state.reconcile(Read::Allowed(vec![]));
        assert_eq!(state.access, Access::Allowed);
        assert!(state.message.is_empty());
        assert!(state.items.is_empty());
    }
    #[test]
    fn permission_revocation_erases_cached_contents_even_after_failed_read() {
        let mut state = Snapshot::default();
        state.reconcile(Read::Allowed(vec![item(1, 10, "private")]));
        state.reconcile(Read::Failed("Unavailable".into()));
        state.reconcile(Read::Blocked(Access::Denied, DENIED_MESSAGE.into()));
        assert_eq!(state.access, Access::Denied);
        assert!(state.items.is_empty());
        assert_eq!(state.updated_at_ms, 0);
    }
    #[test]
    fn clearing_only_targets_displayed_ids_and_never_expands_unknown_selection() {
        let mut state = Snapshot::default();
        state.reconcile(Read::Allowed(vec![item(1, 10, "one"), item(2, 20, "two")]));
        assert_eq!(
            displayed_targets(&state, vec![2, 2]).unwrap(),
            vec![(2, 20)]
        );
        assert!(displayed_targets(&state, vec![1, 99]).is_err());
        assert!(displayed_targets(&state, vec![]).is_err());
        state.reconcile(Read::Allowed(vec![item(1, 10, "one")]));
        assert!(displayed_targets(&state, vec![2]).is_err());
    }
    #[test]
    fn timestamps_and_text_are_bounded_without_discarding_unicode() {
        assert_eq!(date_ms(116_444_736_000_000_000 + 12345 * 10000), 12345);
        assert_eq!(date_ms(0), 0);
        assert_eq!(text(HSTRING::from("A\0日\nB"), 3), "A日");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"fo"), "Zm8=");
    }
    #[test]
    #[ignore = "Passive Windows permission/count probe; never requests access or prints notification contents"]
    fn notification_windows_passive_probe() {
        let _apartment = Apartment::init().expect("WinRT apartment");
        println!("packageIdentity={}", Package::Current().is_ok());
        match UserNotificationListener::Current() {
            Ok(listener) => match listener.GetAccessStatus() {
                Ok(status) => {
                    println!("accessStatus={status:?}");
                    if status == UserNotificationListenerAccessStatus::Allowed {
                        let notifications = listener
                            .GetNotificationsAsync(NotificationKinds::Toast)
                            .unwrap()
                            .get()
                            .unwrap();
                        println!("notificationCount={}", notifications.Size().unwrap());
                    }
                }
                Err(error) => println!("accessError=0x{:08X}", error.code().0 as u32),
            },
            Err(error) => println!("listenerError=0x{:08X}", error.code().0 as u32),
        }
    }
}
