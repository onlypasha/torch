//! A reference shelf, not a directory of copies. Removing entries never changes
//! the original file. Windows owns picking, clipboard and outgoing file drags.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const LIMIT: usize = 128;
const TEXT_LIMIT: usize = 65_536;
const EVENT: &str = "tray-state";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrayItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub value: String,
    pub extension: String,
    pub size_bytes: Option<u64>,
    pub available: bool,
    pub added_at_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    pub items: Vec<TrayItem>,
    pub revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMutation {
    pub snapshot: TraySnapshot,
    pub added: u32,
    pub skipped: u32,
}

pub struct Store {
    path: PathBuf,
    inner: Mutex<TraySnapshot>,
    load_error: Option<String>,
}

impl Store {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = dir.join("tray.json");
        // A damaged shelf must not prevent the whole notch from starting or
        // silently overwrite the previous shelf. Surface the error in Tray.
        Ok(Self::at(path.clone()).unwrap_or_else(|error| Self {
            path,
            inner: Mutex::new(TraySnapshot::default()),
            load_error: Some(error),
        }))
    }

    fn at(path: PathBuf) -> Result<Self, String> {
        let inner = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= LIMIT * (TEXT_LIMIT + 4096) => {
                let snapshot: TraySnapshot = serde_json::from_slice(&bytes).map_err(|_| {
                    "Data Tray tidak dapat dibaca. File tray.json tetap disimpan.".to_owned()
                })?;
                if snapshot.items.len() > LIMIT
                    || snapshot.items.iter().any(|item| {
                        item.value.len() > TEXT_LIMIT
                            || !matches!(item.kind.as_str(), "file" | "folder" | "link" | "text")
                            || (item.kind == "link" && web_link(&item.value).is_none())
                    })
                {
                    return Err("Data Tray tidak valid".into());
                }
                snapshot
            }
            Ok(_) => return Err("Data Tray terlalu besar".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => TraySnapshot::default(),
            Err(e) => return Err(format!("Tidak dapat membaca Tray: {e}")),
        };
        Ok(Self {
            path,
            inner: Mutex::new(inner),
            load_error: None,
        })
    }

    fn commit(&self, snapshot: &TraySnapshot) -> Result<(), String> {
        let dir = self
            .path
            .parent()
            .ok_or("Lokasi penyimpanan Tray tidak valid")?;
        fs::create_dir_all(dir).map_err(|e| format!("Tidak dapat menyimpan Tray: {e}"))?;
        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        // Windows rename cannot replace an existing destination; MoveFileEx
        // replaces only this app-owned JSON atomically, never user files.
        unsafe {
            windows::Win32::Storage::FileSystem::MoveFileExW(
                windows::core::PCWSTR(wide(&temporary.to_string_lossy()).as_ptr()),
                windows::core::PCWSTR(wide(&self.path.to_string_lossy()).as_ptr()),
                windows::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|e| format!("Tidak dapat menyimpan Tray: {e}"))?;
        }
        Ok(())
    }

    fn mutate(
        &self,
        app: &AppHandle,
        additions: Vec<TrayItem>,
        remove: &[String],
        clear: bool,
        mut skipped: u32,
    ) -> Result<TrayMutation, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Tray sedang tidak tersedia")?;
        let mut next = guard.clone();
        if clear {
            next.items.clear();
        }
        next.items.retain(|item| !remove.contains(&item.id));
        let mut added = 0;
        for mut item in additions {
            if next.items.len() >= LIMIT
                || next.items.iter().any(|existing| duplicate(existing, &item))
            {
                skipped += 1;
                continue;
            }
            item.id = format!("{}-{}-{}", epoch_ms(), next.revision, added);
            next.items.push(item);
            added += 1;
        }
        next.revision = next.revision.saturating_add(1);
        self.commit(&next)?;
        *guard = next;
        let snapshot = refresh(guard.clone());
        // Emit under the mutation lock so revisions cannot be published out of order.
        let _ = app.emit(EVENT, &snapshot);
        Ok(TrayMutation {
            snapshot,
            added,
            skipped,
        })
    }

    pub(crate) fn selected(&self, ids: &[String]) -> Result<Vec<TrayItem>, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        if ids.is_empty() || ids.len() > LIMIT {
            return Err("Pilih item Tray terlebih dahulu".into());
        }
        let snapshot = self
            .inner
            .lock()
            .map_err(|_| "Tray sedang tidak tersedia")?;
        let mut seen = HashSet::new();
        ids.iter()
            .filter(|id| seen.insert((*id).clone()))
            .map(|id| {
                snapshot
                    .items
                    .iter()
                    .find(|item| &item.id == id)
                    .cloned()
                    .ok_or("Item sudah tidak ada di Tray".into())
            })
            .collect()
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn web_link(value: &str) -> Option<tauri::Url> {
    tauri::Url::parse(value)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}
fn duplicate(a: &TrayItem, b: &TrayItem) -> bool {
    if matches!(a.kind.as_str(), "file" | "folder") && matches!(b.kind.as_str(), "file" | "folder")
    {
        a.value.eq_ignore_ascii_case(&b.value)
    } else {
        a.kind == b.kind && a.value == b.value
    }
}
fn refresh(mut snapshot: TraySnapshot) -> TraySnapshot {
    for item in &mut snapshot.items {
        if matches!(item.kind.as_str(), "file" | "folder") {
            let metadata = fs::metadata(&item.value).ok();
            item.available = metadata.is_some();
            item.size_bytes = metadata.filter(|m| m.is_file()).map(|m| m.len());
        }
    }
    snapshot
}
fn path_item(value: &str) -> Result<TrayItem, String> {
    if value.len() > TEXT_LIMIT || value.contains('\0') {
        return Err("Lokasi file tidak valid".into());
    }
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| "File tidak ditemukan atau tidak dapat diakses")?;
    let metadata = path.metadata().map_err(|_| "File tidak dapat diakses")?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Jenis file tidak didukung".into());
    }
    let canonical = path.to_string_lossy();
    let value = if let Some(rest) = canonical.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        canonical
            .strip_prefix(r"\\?\")
            .unwrap_or(&canonical)
            .to_owned()
    };
    Ok(TrayItem {
        id: String::new(),
        kind: if metadata.is_dir() { "folder" } else { "file" }.into(),
        name: path
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| value.clone()),
        extension: path
            .extension()
            .map(|v| v.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
        value,
        size_bytes: metadata.is_file().then_some(metadata.len()),
        available: true,
        added_at_ms: epoch_ms(),
    })
}
fn text_item(value: &str) -> Result<TrayItem, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Clipboard kosong".into());
    }
    if value.len() > TEXT_LIMIT || value.contains('\0') {
        return Err("Teks terlalu panjang (maksimal 64 KB)".into());
    }
    let link = web_link(value);
    let kind = if link.is_some() { "link" } else { "text" };
    let name = link
        .as_ref()
        .and_then(|url| url.host_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            value
                .lines()
                .next()
                .unwrap_or(value)
                .chars()
                .take(80)
                .collect()
        });
    Ok(TrayItem {
        id: String::new(),
        kind: kind.into(),
        name,
        value: value.into(),
        extension: String::new(),
        size_bytes: None,
        available: true,
        added_at_ms: epoch_ms(),
    })
}
fn add_paths(app: &AppHandle, paths: Vec<String>) -> Result<TrayMutation, String> {
    if paths.len() > LIMIT {
        return Err("Maksimal 128 item sekaligus".into());
    }
    let mut skipped = 0;
    let items = paths
        .iter()
        .filter_map(|path| match path_item(path) {
            Ok(item) => Some(item),
            Err(_) => {
                skipped += 1;
                None
            }
        })
        .collect();
    app.state::<Store>().mutate(app, items, &[], false, skipped)
}

#[tauri::command]
pub fn tray_snapshot(store: State<'_, Store>) -> Result<TraySnapshot, String> {
    if let Some(error) = &store.load_error {
        return Err(error.clone());
    }
    Ok(refresh(
        store
            .inner
            .lock()
            .map_err(|_| "Tray sedang tidak tersedia")?
            .clone(),
    ))
}
#[tauri::command]
pub async fn tray_add_paths(app: AppHandle, paths: Vec<String>) -> Result<TrayMutation, String> {
    tauri::async_runtime::spawn_blocking(move || add_paths(&app, paths))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn tray_add_text(
    app: AppHandle,
    text: String,
    store: State<'_, Store>,
) -> Result<TrayMutation, String> {
    store.mutate(&app, vec![text_item(&text)?], &[], false, 0)
}
#[tauri::command]
pub fn tray_remove(
    app: AppHandle,
    ids: Vec<String>,
    store: State<'_, Store>,
) -> Result<TrayMutation, String> {
    if ids.len() > LIMIT {
        return Err("Pilihan item terlalu banyak".into());
    }
    store.mutate(&app, vec![], &ids, false, 0)
}
#[tauri::command]
pub fn tray_clear(app: AppHandle, store: State<'_, Store>) -> Result<TrayMutation, String> {
    store.mutate(&app, vec![], &[], true, 0)
}
#[tauri::command]
pub fn tray_open(id: String, window: WebviewWindow, store: State<'_, Store>) -> Result<(), String> {
    let item = store.selected(&[id])?.remove(0);
    let value = match item.kind.as_str() {
        "file" | "folder" if Path::new(&item.value).exists() => item.value,
        "link" if web_link(&item.value).is_some() => item.value,
        "text" => return Err("Gunakan Salin untuk mengambil teks".into()),
        _ => {
            return Err(
                "File tidak tersedia. Pulihkan lokasi aslinya atau hapus dari Tray.".into(),
            );
        }
    };
    let result = unsafe {
        windows::Win32::UI::Shell::ShellExecuteW(
            owner(&window)?,
            windows::core::w!("open"),
            windows::core::PCWSTR(wide(&value).as_ptr()),
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
        )
    };
    if result.0 as usize <= 32 {
        Err("Item tidak dapat dibuka oleh aplikasi default".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub fn tray_reveal(id: String, store: State<'_, Store>) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let item = store.selected(&[id])?.remove(0);
    if !matches!(item.kind.as_str(), "file" | "folder") || !Path::new(&item.value).exists() {
        return Err("File tidak tersedia".into());
    }
    // Pass one argument, never construct a shell command from a path.
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", item.value))
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn owner(window: &WebviewWindow) -> Result<windows::Win32::Foundation::HWND, String> {
    window
        .hwnd()
        .map(|handle| windows::Win32::Foundation::HWND(handle.0 as _))
        .map_err(|e| e.to_string())
}

pub(crate) mod native {
    use super::*;
    use windows::{
        Win32::{
            Foundation::{
                BOOL, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, GlobalFree,
                HANDLE, HGLOBAL, HWND, S_OK,
            },
            System::{
                Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemFree, IDataObject},
                DataExchange::{
                    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
                    OpenClipboard, SetClipboardData,
                },
                Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock},
                Ole::{
                    CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, IDropSource,
                    IDropSource_Impl, OleInitialize, OleUninitialize,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::Shell::{
                Common::ITEMIDLIST, DROPFILES, DragQueryFileW, FOS_ALLOWMULTISELECT,
                FOS_DONTADDTORECENT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST,
                FileOpenDialog, HDROP, IFileOpenDialog, SHCreateDataObject, SHDoDragDrop,
                SHParseDisplayName, SIGDN_FILESYSPATH,
            },
        },
        core::{HRESULT, PCWSTR, implement},
    };

    struct Clipboard;
    impl Clipboard {
        fn open(owner: HWND) -> Result<Self, String> {
            for _ in 0..5 {
                if unsafe { OpenClipboard(owner) }.is_ok() {
                    return Ok(Self);
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err("Clipboard sedang digunakan aplikasi lain. Coba lagi.".into())
        }
    }
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    struct Ole;
    impl Ole {
        fn init() -> Result<Self, String> {
            unsafe {
                OleInitialize(None).map_err(|e| e.to_string())?;
            }
            Ok(Self)
        }
    }
    impl Drop for Ole {
        fn drop(&mut self) {
            unsafe {
                OleUninitialize();
            }
        }
    }

    pub enum Pasted {
        Paths(Vec<String>),
        Text(String),
    }
    pub fn paste(owner: HWND) -> Result<Pasted, String> {
        let _clipboard = Clipboard::open(owner)?;
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
                let data = GetClipboardData(CF_HDROP.0 as u32).map_err(|e| e.to_string())?;
                let drop = HDROP(data.0);
                let count = DragQueryFileW(drop, u32::MAX, None);
                if count as usize > LIMIT {
                    return Err("Clipboard berisi lebih dari 128 file".into());
                }
                let mut paths = Vec::new();
                for index in 0..count {
                    let length = DragQueryFileW(drop, index, None);
                    let mut buffer = vec![0u16; length as usize + 1];
                    DragQueryFileW(drop, index, Some(&mut buffer));
                    paths.push(String::from_utf16_lossy(&buffer[..length as usize]));
                }
                return Ok(Pasted::Paths(paths));
            }
            let data = GetClipboardData(CF_UNICODETEXT.0 as u32)
                .map_err(|_| "Clipboard tidak berisi file, tautan, atau teks")?;
            let global = HGLOBAL(data.0 as *mut _);
            let bytes = GlobalSize(global);
            if bytes > TEXT_LIMIT * 2 + 2 {
                return Err("Teks clipboard terlalu panjang".into());
            }
            let ptr = GlobalLock(global) as *const u16;
            if ptr.is_null() {
                return Err("Clipboard tidak dapat dibaca".into());
            }
            let chars = std::slice::from_raw_parts(ptr, bytes / 2);
            let end = chars.iter().position(|v| *v == 0).unwrap_or(chars.len());
            let text = String::from_utf16_lossy(&chars[..end]);
            let _ = GlobalUnlock(global);
            Ok(Pasted::Text(text))
        }
    }
    fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
            let ptr = GlobalLock(memory);
            if ptr.is_null() {
                let _ = GlobalFree(memory);
                return Err("Clipboard tidak dapat ditulis".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(memory);
            if let Err(error) = SetClipboardData(format, HANDLE(memory.0 as isize)) {
                let _ = GlobalFree(memory);
                return Err(error.to_string());
            }
        }
        Ok(())
    }
    pub fn copy(owner: HWND, items: Vec<TrayItem>) -> Result<(), String> {
        if items.iter().any(|item| {
            matches!(item.kind.as_str(), "file" | "folder") && !Path::new(&item.value).exists()
        }) {
            return Err("Salah satu file tidak tersedia".into());
        }
        let _clipboard = Clipboard::open(owner)?;
        unsafe {
            EmptyClipboard().map_err(|e| e.to_string())?;
        }
        if items
            .iter()
            .all(|item| matches!(item.kind.as_str(), "file" | "folder"))
        {
            let mut paths: Vec<u16> = items.iter().flat_map(|item| wide(&item.value)).collect();
            paths.push(0);
            let mut bytes = vec![0; std::mem::size_of::<DROPFILES>() + paths.len() * 2];
            bytes[..4].copy_from_slice(&(std::mem::size_of::<DROPFILES>() as u32).to_le_bytes());
            bytes[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide = TRUE
            for (i, value) in paths.iter().enumerate() {
                bytes[std::mem::size_of::<DROPFILES>() + i * 2
                    ..std::mem::size_of::<DROPFILES>() + i * 2 + 2]
                    .copy_from_slice(&value.to_le_bytes());
            }
            put(CF_HDROP.0 as u32, &bytes)
        } else {
            let text = items
                .iter()
                .map(|item| item.value.as_str())
                .collect::<Vec<_>>()
                .join("\r\n");
            let bytes: Vec<u8> = wide(&text).into_iter().flat_map(u16::to_le_bytes).collect();
            put(CF_UNICODETEXT.0 as u32, &bytes)
        }
    }
    pub fn pick(owner: HWND) -> Result<Vec<String>, String> {
        let _ole = Ole::init()?;
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;
            dialog
                .SetOptions(
                    FOS_ALLOWMULTISELECT
                        | FOS_FORCEFILESYSTEM
                        | FOS_FILEMUSTEXIST
                        | FOS_PATHMUSTEXIST
                        | FOS_DONTADDTORECENT,
                )
                .map_err(|e| e.to_string())?;
            if let Err(e) = dialog.Show(owner) {
                if e.code().0 as u32 == 0x800704c7 {
                    return Ok(vec![]);
                }
                return Err(e.to_string());
            }
            let results = dialog.GetResults().map_err(|e| e.to_string())?;
            let count = results.GetCount().map_err(|e| e.to_string())?;
            if count as usize > LIMIT {
                return Err("Maksimal 128 file sekaligus".into());
            }
            let mut paths = Vec::new();
            for index in 0..count {
                let item = results.GetItemAt(index).map_err(|e| e.to_string())?;
                let path = item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|e| e.to_string())?;
                let value = path.to_string().map_err(|e| e.to_string());
                CoTaskMemFree(Some(path.0 as _));
                paths.push(value?);
            }
            Ok(paths)
        }
    }
    #[implement(IDropSource)]
    struct DropSource;
    impl IDropSource_Impl for DropSource {
        fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape.as_bool() {
                DRAGDROP_S_CANCEL
            } else if keys.0 & 1 == 0 {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
        fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }
    struct Pidls(Vec<*mut ITEMIDLIST>);
    impl Drop for Pidls {
        fn drop(&mut self) {
            for pidl in &self.0 {
                unsafe {
                    CoTaskMemFree(Some(*pidl as _));
                }
            }
        }
    }
    pub fn drag(owner: HWND, items: Vec<TrayItem>) -> Result<(), String> {
        let _ole = Ole::init()?;
        let mut pidls = Pidls(Vec::new());
        let paths: Vec<String> = items.iter().map(|item| item.value.clone()).collect();
        unsafe {
            for item in items {
                if !matches!(item.kind.as_str(), "file" | "folder")
                    || !Path::new(&item.value).exists()
                {
                    return Err("Pilih file atau folder yang tersedia untuk diseret".into());
                }
                let mut pidl = std::ptr::null_mut();
                SHParseDisplayName(PCWSTR(wide(&item.value).as_ptr()), None, &mut pidl, 0, None)
                    .map_err(|e| e.to_string())?;
                pidls.0.push(pidl);
            }
            let children: Vec<*const ITEMIDLIST> = pidls.0.iter().map(|p| *p as *const _).collect();
            let data: IDataObject =
                SHCreateDataObject(None, Some(&children), None).map_err(|e| e.to_string())?;
            crate::tray_drop::set_file_paths(&data, &paths).map_err(|e| e.to_string())?;
            let source: IDropSource = DropSource.into();
            SHDoDragDrop(owner, &data, &source, DROPEFFECT_COPY).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn tray_copy(
    ids: Vec<String>,
    window: WebviewWindow,
    store: State<'_, Store>,
) -> Result<(), String> {
    let items = store.selected(&ids)?;
    let hwnd = owner(&window)?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        native::copy(windows::Win32::Foundation::HWND(hwnd as _), items)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn tray_paste(app: AppHandle, window: WebviewWindow) -> Result<TrayMutation, String> {
    let hwnd = owner(&window)?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        match native::paste(windows::Win32::Foundation::HWND(hwnd as _))? {
            native::Pasted::Paths(paths) => add_paths(&app, paths),
            native::Pasted::Text(text) => {
                app.state::<Store>()
                    .mutate(&app, vec![text_item(&text)?], &[], false, 0)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn tray_pick_files(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<TrayMutation, String> {
    let hwnd = owner(&window)?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        add_paths(
            &app,
            native::pick(windows::Win32::Foundation::HWND(hwnd as _))?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn tray_start_drag(
    ids: Vec<String>,
    window: WebviewWindow,
    store: State<'_, Store>,
) -> Result<(), String> {
    let items = store.selected(&ids)?;
    let hwnd = owner(&window)?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        native::drag(windows::Win32::Foundation::HWND(hwnd as _), items)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_only_allow_web_schemes_and_text_is_bounded() {
        assert_eq!(
            text_item(" https://example.com/path ").unwrap().kind,
            "link"
        );
        assert_eq!(text_item("javascript:alert(1)").unwrap().kind, "text");
        assert_eq!(text_item("file:///C:/private").unwrap().kind, "text");
        assert!(text_item(&"x".repeat(TEXT_LIMIT + 1)).is_err());
        assert!(text_item("\0bad").is_err());
        assert!(text_item(" ").is_err());
    }
    #[test]
    fn persistence_preserves_references_and_missing_files_remain_removable() {
        let dir = std::env::temp_dir().join(format!(
            "notch-tray-test-{}-{}",
            std::process::id(),
            epoch_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("original.txt");
        fs::write(&original, "keep me").unwrap();
        let path = dir.join("tray.json");
        let store = Store::at(path.clone()).unwrap();
        let item = path_item(original.to_str().unwrap()).unwrap();
        assert!(duplicate(
            &item,
            &path_item(original.to_str().unwrap()).unwrap()
        ));
        let snapshot = TraySnapshot {
            items: vec![item],
            revision: 5,
        };
        store.commit(&snapshot).unwrap();
        let loaded = Store::at(path).unwrap();
        assert_eq!(loaded.inner.lock().unwrap().revision, 5);
        // Clearing the shelf persists only metadata; the original is untouched.
        store.commit(&TraySnapshot::default()).unwrap();
        assert_eq!(fs::read_to_string(&original).unwrap(), "keep me");
        fs::remove_file(&original).unwrap();
        assert!(!refresh(snapshot).items[0].available);
        fs::remove_file(dir.join("tray.json")).unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
