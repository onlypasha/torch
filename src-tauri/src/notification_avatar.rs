//! Optional, read-only lookup of the image embedded in a WhatsApp toast.
//! Windows' supported listener remains the source of active notification IDs.
use futures_util::StreamExt;
use quick_xml::{Reader, XmlVersion, events::Event};
use std::{
    ffi::{CString, c_char, c_int, c_void},
    path::PathBuf,
    ptr,
    time::Duration,
};

const MAX_PAYLOAD: usize = 64 * 1024;
const MAX_IMAGE: usize = 1024 * 1024;
const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_OPEN_READONLY: c_int = 1;

#[repr(C)]
struct Db {
    _private: [u8; 0],
}
#[repr(C)]
struct Statement {
    _private: [u8; 0],
}
#[link(name = "winsqlite3")]
unsafe extern "C" {
    fn sqlite3_open_v2(
        path: *const c_char,
        db: *mut *mut Db,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close(db: *mut Db) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut Db,
        sql: *const c_char,
        bytes: c_int,
        statement: *mut *mut Statement,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_finalize(statement: *mut Statement) -> c_int;
    fn sqlite3_bind_int64(statement: *mut Statement, index: c_int, value: i64) -> c_int;
    fn sqlite3_bind_text(
        statement: *mut Statement,
        index: c_int,
        text: *const c_char,
        bytes: c_int,
        destructor: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_step(statement: *mut Statement) -> c_int;
    fn sqlite3_column_blob(statement: *mut Statement, index: c_int) -> *const c_void;
    #[cfg(test)]
    fn sqlite3_column_text(statement: *mut Statement, index: c_int) -> *const u8;
    fn sqlite3_column_bytes(statement: *mut Statement, index: c_int) -> c_int;
    fn sqlite3_column_int64(statement: *mut Statement, index: c_int) -> i64;
    fn sqlite3_busy_timeout(db: *mut Db, milliseconds: c_int) -> c_int;
}

struct Connection(*mut Db);
impl Drop for Connection {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                sqlite3_close(self.0);
            }
        }
    }
}
struct Query(*mut Statement);
impl Drop for Query {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                sqlite3_finalize(self.0);
            }
        }
    }
}

fn payload(id: u32, app_id: &str, created_at_ms: u64) -> Option<Vec<u8>> {
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    let path = root
        .join("Microsoft")
        .join("Windows")
        .join("Notifications")
        .join("wpndatabase.db");
    let path = CString::new(path.to_str()?).ok()?;
    let mut raw = ptr::null_mut();
    // The system SQLite can read the live WAL without writing to Windows' DB.
    let status =
        unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, SQLITE_OPEN_READONLY, ptr::null()) };
    let db = Connection(raw);
    if status != SQLITE_OK || db.0.is_null() {
        return None;
    }
    unsafe {
        sqlite3_busy_timeout(db.0, 300);
    }
    payload_from_connection(&db, id, app_id, created_at_ms)
}

fn payload_from_connection(
    db: &Connection,
    id: u32,
    app_id: &str,
    created_at_ms: u64,
) -> Option<Vec<u8>> {
    let app_id = CString::new(app_id).ok()?;
    let sql = c"SELECT n.Payload,n.ArrivalTime FROM Notification n JOIN NotificationHandler h ON h.RecordId=n.HandlerId WHERE n.Id=?1 AND h.PrimaryId=?2 AND n.Type='toast' LIMIT 1";
    let mut raw_query = ptr::null_mut();
    if unsafe { sqlite3_prepare_v2(db.0, sql.as_ptr(), -1, &mut raw_query, ptr::null_mut()) }
        != SQLITE_OK
    {
        return None;
    }
    let query = Query(raw_query);
    if unsafe { sqlite3_bind_int64(query.0, 1, id as i64) } != SQLITE_OK
        || unsafe { sqlite3_bind_text(query.0, 2, app_id.as_ptr(), -1, None) } != SQLITE_OK
        || unsafe { sqlite3_step(query.0) } != SQLITE_ROW
    {
        return None;
    }
    let arrival = unsafe { sqlite3_column_int64(query.0, 1) };
    if super::date_ms(arrival) != created_at_ms {
        return None;
    }
    let length = unsafe { sqlite3_column_bytes(query.0, 0) };
    if length <= 0 || length as usize > MAX_PAYLOAD {
        return None;
    }
    let bytes = unsafe { sqlite3_column_blob(query.0, 0) } as *const u8;
    if bytes.is_null() {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(bytes, length as usize) }.to_vec())
}

fn image_source(payload: &[u8]) -> Option<String> {
    if payload.len() > MAX_PAYLOAD {
        return None;
    }
    let mut xml = Reader::from_reader(payload);
    loop {
        match xml.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) if tag.name().as_ref() == "image" => {
                let mut placement = None;
                let mut source = None;
                for attribute in tag.attributes().flatten() {
                    let value = attribute
                        .normalized_value(XmlVersion::Implicit1_0)
                        .ok()?
                        .to_string();
                    match attribute.key.as_ref() {
                        "placement" => placement = Some(value),
                        "src" => source = Some(value),
                        _ => {}
                    }
                }
                if placement.as_deref() == Some("appLogoOverride") {
                    return source;
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn allowed_url(source: &str) -> Option<reqwest::Url> {
    if source.len() > 4096 {
        return None;
    }
    let url = reqwest::Url::parse(source).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port(), None | Some(443))
        || !(host == "static.whatsapp.net" || host.ends_with(".cdn.whatsapp.net"))
    {
        return None;
    }
    Some(url)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub async fn resolve(id: u32, app_id: &str, created_at_ms: u64) -> Option<String> {
    let payload = payload(id, app_id, created_at_ms)?;
    let source = image_source(&payload)?;
    let url = allowed_url(&source)?;
    // No source URL, signed token, or message text is emitted or persisted.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "image/*")
        .send()
        .await
        .ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_IMAGE as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = image_mime(&bytes)?;
    Some(format!("data:{mime};base64,{}", super::base64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_only_app_logo_override() {
        let xml = br#"<toast><visual><binding template="ToastGeneric"><image src="https://example.com/x"/><image placement="appLogoOverride" hint-crop="circle" src="https://media-x.cdn.whatsapp.net/photo?a=1&amp;b=2"/></binding></visual></toast>"#;
        assert_eq!(
            image_source(xml).as_deref(),
            Some("https://media-x.cdn.whatsapp.net/photo?a=1&b=2")
        );
    }
    #[test]
    fn rejects_other_hosts_and_formats() {
        assert!(allowed_url("https://media-x.cdn.whatsapp.net/p").is_some());
        assert!(allowed_url("https://static.whatsapp.net/p").is_some());
        for url in [
            "http://media-x.cdn.whatsapp.net/p",
            "https://evilcdn.whatsapp.net/p",
            "https://media-x.cdn.whatsapp.net.evil.test/p",
            "https://user@static.whatsapp.net/p",
            "https://media-x.cdn.whatsapp.net:444/p",
        ] {
            assert!(allowed_url(url).is_none());
        }
        assert_eq!(image_mime(b"<svg/>"), None);
    }
    #[test]
    fn requires_exact_notification_id_app_and_arrival_time() {
        #[link(name = "winsqlite3")]
        unsafe extern "C" {
            fn sqlite3_exec(
                db: *mut Db,
                sql: *const c_char,
                callback: Option<
                    unsafe extern "C" fn(
                        *mut c_void,
                        c_int,
                        *mut *mut c_char,
                        *mut *mut c_char,
                    ) -> c_int,
                >,
                context: *mut c_void,
                error: *mut *mut c_char,
            ) -> c_int;
        }
        let mut raw = ptr::null_mut();
        assert_eq!(
            unsafe { sqlite3_open_v2(c":memory:".as_ptr(), &mut raw, 6, ptr::null()) },
            SQLITE_OK
        );
        let db = Connection(raw);
        let arrival = 116_444_736_000_000_000i64 + 123_456 * 10_000;
        let sql = CString::new(format!("CREATE TABLE NotificationHandler(RecordId INTEGER,PrimaryId TEXT); CREATE TABLE Notification(Id INTEGER,HandlerId INTEGER,Type TEXT,Payload BLOB,ArrivalTime INTEGER); INSERT INTO NotificationHandler VALUES(1,'WhatsAppDesktop!App'); INSERT INTO Notification VALUES(42,1,'toast',X'010203',{arrival});")).unwrap();
        assert_eq!(
            unsafe { sqlite3_exec(db.0, sql.as_ptr(), None, ptr::null_mut(), ptr::null_mut()) },
            SQLITE_OK
        );
        assert_eq!(
            payload_from_connection(&db, 42, "WhatsAppDesktop!App", 123_456),
            Some(vec![1, 2, 3])
        );
        assert_eq!(
            payload_from_connection(&db, 43, "WhatsAppDesktop!App", 123_456),
            None
        );
        assert_eq!(payload_from_connection(&db, 42, "OtherApp", 123_456), None);
        assert_eq!(
            payload_from_connection(&db, 42, "WhatsAppDesktop!App", 123_457),
            None
        );
    }
    #[test]
    #[ignore = "reads the live Windows notification database without exporting payloads"]
    fn live_database_payload_probe() {
        let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
        let path = root.join("Microsoft/Windows/Notifications/wpndatabase.db");
        let path = CString::new(path.to_str().unwrap()).unwrap();
        let mut raw = ptr::null_mut();
        assert_eq!(
            unsafe { sqlite3_open_v2(path.as_ptr(), &mut raw, SQLITE_OPEN_READONLY, ptr::null()) },
            SQLITE_OK
        );
        let db = Connection(raw);
        let sql = c"SELECT n.Id,n.ArrivalTime,h.PrimaryId FROM Notification n JOIN NotificationHandler h ON h.RecordId=n.HandlerId WHERE h.PrimaryId LIKE '%WhatsAppDesktop%' AND n.Type='toast' ORDER BY n.ArrivalTime DESC LIMIT 1";
        let mut raw_query = ptr::null_mut();
        assert_eq!(
            unsafe { sqlite3_prepare_v2(db.0, sql.as_ptr(), -1, &mut raw_query, ptr::null_mut()) },
            SQLITE_OK
        );
        let query = Query(raw_query);
        if unsafe { sqlite3_step(query.0) } != SQLITE_ROW {
            println!("activeDatabaseToast=0");
            return;
        }
        let id = unsafe { sqlite3_column_int64(query.0, 0) } as u32;
        let time = super::super::date_ms(unsafe { sqlite3_column_int64(query.0, 1) });
        let app =
            unsafe { std::ffi::CStr::from_ptr(sqlite3_column_text(query.0, 2) as *const c_char) }
                .to_str()
                .unwrap();
        let payload = payload_from_connection(&db, id, app, time);
        println!(
            "activeDatabaseToast=1 matchedPayload={} hasAppLogo={}",
            payload.is_some(),
            payload.as_deref().and_then(image_source).is_some()
        );
        assert!(payload.is_some());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let fetched = runtime.block_on(resolve(id, app, time)).is_some();
        println!("fetchedValidatedAvatar={fetched}");
    }
}
