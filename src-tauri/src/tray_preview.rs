//! Native file previews for the shelf's 56 logical pixel icons. The Shell
//! renders a thumbnail where supported and otherwise the registered file icon.
//! Images are returned as bounded BMP V5 data URLs; no file contents are copied
//! to application storage and no remote image URLs are fetched.
use crate::tray::Store;
use tauri::State;
use windows::{
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{
            BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS,
            DeleteDC, DeleteObject, GetDIBits, GetObjectW, HBITMAP, HDC,
        },
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
        UI::Shell::{
            IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY,
            SIIGBF_RESIZETOFIT,
        },
    },
    core::PCWSTR,
};

const EDGE: i32 = 112;
static PREVIEW_WORKER: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn tray_preview(id: String, store: State<'_, Store>) -> Result<Option<String>, String> {
    let item = store.selected(&[id])?.remove(0);
    if !matches!(item.kind.as_str(), "file" | "folder") || item.value.starts_with(r"\\") {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Keep Shell thumbnail handlers off the UI thread and serialize this
        // bounded work even if several visible tiles request images together.
        let _worker = PREVIEW_WORKER
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Ok(path) = std::path::Path::new(&item.value).canonicalize() else {
            return None;
        };
        // Canonical paths use \\?\ locally and \\?\UNC\ for remote shares.
        let path = path.to_string_lossy();
        if path.starts_with(r"\\?\UNC\") || (path.starts_with(r"\\") && !path.starts_with(r"\\?\"))
        {
            return None;
        }
        shell_preview(path.strip_prefix(r"\\?\").unwrap_or(&path))
    })
    .await
    .map_err(|error| error.to_string())
}

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0);
        }
    }
}
struct DeviceContext(HDC);
impl Drop for DeviceContext {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

fn shell_preview(path: &str) -> Option<String> {
    shell_bitmap(path).map(|bytes| format!("data:image/bmp;base64,{}", base64(&bytes)))
}

fn shell_bitmap(path: &str) -> Option<Vec<u8>> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().ok()?;
    }
    let _com = Com;
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()? };
    let size = SIZE { cx: EDGE, cy: EDGE };
    let bitmap = Bitmap(unsafe {
        factory
            .GetImage(size, SIIGBF_RESIZETOFIT)
            .or_else(|_| factory.GetImage(size, SIIGBF_ICONONLY))
            .ok()?
    });
    let mut object = BITMAP::default();
    if unsafe {
        GetObjectW(
            bitmap.0,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut object as *mut _ as *mut _),
        )
    } == 0
    {
        return None;
    }
    let width = object.bmWidth;
    let height = object.bmHeight.checked_abs()?;
    if width <= 0 || height <= 0 || width > EDGE || height > EDGE {
        return None;
    }
    let dc = DeviceContext(unsafe { CreateCompatibleDC(None) });
    if dc.0.0 == 0 {
        return None;
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    if unsafe {
        GetDIBits(
            dc.0,
            bitmap.0,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    } != height
    {
        return None;
    }
    encode_bmp(width as u32, height as u32, &pixels)
}

/// Explicit V5 channel masks preserve icon transparency in Chromium/WebView2.
/// Shell bitmaps use premultiplied BGRA; BMP encodes straight alpha instead.
fn encode_bmp(width: u32, height: u32, pixels: &[u8]) -> Option<Vec<u8>> {
    if width == 0
        || height == 0
        || width > EDGE as u32
        || height > EDGE as u32
        || pixels.len() != width as usize * height as usize * 4
    {
        return None;
    }
    const OFFSET: usize = 14 + 124;
    let mut bmp = vec![0u8; OFFSET + pixels.len()];
    bmp[..2].copy_from_slice(b"BM");
    let size = bmp.len() as u32;
    bmp[2..6].copy_from_slice(&size.to_le_bytes());
    bmp[10..14].copy_from_slice(&(OFFSET as u32).to_le_bytes());
    bmp[14..18].copy_from_slice(&124u32.to_le_bytes());
    bmp[18..22].copy_from_slice(&(width as i32).to_le_bytes());
    bmp[22..26].copy_from_slice(&(-(height as i32)).to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&32u16.to_le_bytes());
    bmp[30..34].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
    bmp[34..38].copy_from_slice(&(pixels.len() as u32).to_le_bytes());
    for (at, mask) in [
        (54, 0x00ff0000u32),
        (58, 0x0000ff00),
        (62, 0x000000ff),
        (66, 0xff000000),
    ] {
        bmp[at..at + 4].copy_from_slice(&mask.to_le_bytes());
    }
    bmp[70..74].copy_from_slice(&0x73524742u32.to_le_bytes()); // LCS_sRGB
    let opaque = pixels.chunks_exact(4).all(|pixel| pixel[3] == 0);
    for (source, target) in pixels
        .chunks_exact(4)
        .zip(bmp[OFFSET..].chunks_exact_mut(4))
    {
        let alpha = if opaque { 255 } else { source[3] };
        for channel in 0..3 {
            target[channel] = if alpha == 0 {
                0
            } else if opaque {
                source[channel]
            } else {
                ((u32::from(source[channel]) * 255 + u32::from(alpha) / 2) / u32::from(alpha))
                    .min(255) as u8
            };
        }
        target[3] = alpha;
    }
    Some(bmp)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        encoded.push(TABLE[(value >> 18) as usize & 63] as char);
        encoded.push(TABLE[(value >> 12) as usize & 63] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[value as usize & 63] as char
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bmp_has_explicit_alpha_top_down_pixels_and_straight_channels() {
        let bmp = encode_bmp(2, 1, &[20, 40, 60, 128, 9, 8, 7, 0]).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 138);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -1);
        assert_eq!(&bmp[66..70], &0xff000000u32.to_le_bytes());
        assert_eq!(&bmp[138..], &[40, 80, 120, 128, 0, 0, 0, 0]);
        assert!(encode_bmp(113, 1, &[0; 452]).is_none());
        assert!(encode_bmp(2, 1, &[0; 4]).is_none());
    }
    #[test]
    fn icons_without_alpha_are_opaque_and_base64_is_padded() {
        let bmp = encode_bmp(1, 1, &[10, 20, 30, 0]).unwrap();
        assert_eq!(&bmp[138..], &[10, 20, 30, 255]);
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
    }

    #[test]
    #[ignore = "manual read-only Windows Shell icon extraction; writes one temporary preview BMP"]
    fn windows_shell_icon_probe() {
        let original = std::env::current_exe().unwrap();
        let image = shell_bitmap(original.to_str().unwrap()).expect("Windows file icon");
        let path = std::env::temp_dir().join(format!(
            "notch-tray-shell-preview-{}.bmp",
            std::process::id()
        ));
        std::fs::write(&path, &image).unwrap();
        println!(
            "preview={} bytes={} source={}",
            path.display(),
            image.len(),
            original.display()
        );
    }
}
