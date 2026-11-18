use crate::{sharing, tray::native};
use tauri::{State, WebviewWindow};

async fn clipboard(window: &WebviewWindow) -> Result<native::Pasted, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    tauri::async_runtime::spawn_blocking(move || {
        native::paste(windows::Win32::Foundation::HWND(hwnd as _))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sharing_add_peer_clipboard(
    window: WebviewWindow,
    store: State<'_, sharing::Store>,
) -> Result<sharing::Snapshot, String> {
    match clipboard(&window).await? {
        native::Pasted::Text(address) => {
            sharing::sharing_add_peer(address.trim().to_owned(), store).await
        }
        native::Pasted::Paths(_) => {
            Err("Salin alamat IP perangkat tujuan, lalu pilih IP dari clipboard.".into())
        }
    }
}
