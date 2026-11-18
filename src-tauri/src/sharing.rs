//! LocalSend v2 sender adapted from the original NotchApp's LocalSend services.
//! Discovery exchanges metadata only; file bytes leave only after sharing_send.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

const PORT: u16 = 53317;
const GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const API: &str = "/api/localsend/v2";
const FILE_LIMIT: usize = 128;
const JSON_LIMIT: usize = 262_144;
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub alias: String,
    pub device_model: String,
    pub device_type: String,
    pub ip_address: String,
    pub port: u16,
    pub protocol: String,
    pub fingerprint: String,
    pub last_seen_ms: u64,
}
impl Peer {
    fn base(&self) -> String {
        let host = if self.ip_address.contains(':') {
            format!("[{}]", self.ip_address)
        } else {
            self.ip_address.clone()
        };
        format!("{}://{}:{}", self.protocol, host, self.port)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub state: String,
    pub peer_id: String,
    pub peer_name: String,
    pub current_file: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub message: String,
}
impl Default for Transfer {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            peer_id: String::new(),
            peer_name: String::new(),
            current_file: String::new(),
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            message: String::new(),
        }
    }
}
impl Transfer {
    fn busy(&self) -> bool {
        matches!(self.state.as_str(), "waiting" | "sending")
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub alias: String,
    pub fingerprint: String,
    pub server_running: bool,
    pub discovering: bool,
    pub diagnostic: String,
    pub peers: Vec<Peer>,
    pub transfer: Transfer,
}
impl Snapshot {
    fn unavailable(error: String) -> Self {
        Self {
            revision: 0,
            alias: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Notch".into()),
            fingerprint: String::new(),
            server_running: false,
            discovering: false,
            diagnostic: format!("Sharing belum tersedia: {error}"),
            peers: vec![],
            transfer: Transfer::default(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct IdentityDisk {
    certificate: Vec<u8>,
    private_key: Vec<u8>,
    certificate_pem: String,
    private_key_pem: String,
}
struct Identity {
    disk: IdentityDisk,
    alias: String,
    fingerprint: String,
}
#[derive(Debug)]
struct FingerprintVerifier {
    expected: Option<String>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl rustls::client::danger::ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| !expected.eq_ignore_ascii_case(&fingerprint(end.as_ref())))
        {
            return Err(rustls::Error::General(
                "LocalSend certificate fingerprint changed".into(),
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
fn http_client(identity: &Identity, expected: Option<&str>) -> Result<reqwest::Client, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier {
            expected: expected.filter(|s| !s.is_empty()).map(str::to_owned),
            provider,
        }))
        .with_client_auth_cert(
            vec![rustls::pki_types::CertificateDer::from(
                identity.disk.certificate.clone(),
            )],
            rustls::pki_types::PrivatePkcs8KeyDer::from(identity.disk.private_key.clone()).into(),
        )
        .map_err(|e| e.to_string())?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .tls_info(true)
        .http1_only()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())
}
impl Identity {
    fn load(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let path = directory.join("sharing-identity.json");
        let disk = if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            if bytes.len() > 65536 {
                return Err("Identitas Sharing tidak valid".into());
            }
            serde_json::from_slice::<IdentityDisk>(&bytes)
                .map_err(|_| "Identitas Sharing tidak dapat dibaca")?
        } else {
            let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
            let params = rcgen::CertificateParams::new(vec!["notch.local".into()])
                .map_err(|e| e.to_string())?;
            let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
            let disk = IdentityDisk {
                certificate: cert.der().to_vec(),
                private_key: key.serialize_der(),
                certificate_pem: cert.pem(),
                private_key_pem: key.serialize_pem(),
            };
            let bytes = serde_json::to_vec(&disk).map_err(|e| e.to_string())?;
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            disk
        };
        let alias = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Notch".into());
        Ok(Self {
            fingerprint: fingerprint(&disk.certificate),
            alias,
            disk,
        })
    }
    fn dto(&self, port: u16, announce: bool) -> DeviceInfo {
        DeviceInfo {
            alias: self.alias.clone(),
            version: "2.0".into(),
            device_model: "Notch for Windows".into(),
            device_type: "desktop".into(),
            fingerprint: self.fingerprint.clone(),
            port,
            protocol: "https".into(),
            download: false,
            announce,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DeviceInfo {
    alias: String,
    version: String,
    #[serde(deserialize_with = "nullable_model")]
    device_model: String,
    #[serde(deserialize_with = "nullable_device_type")]
    device_type: String,
    fingerprint: String,
    port: u16,
    protocol: String,
    download: bool,
    announce: bool,
}
fn nullable_model<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}
fn nullable_device_type<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(|| "desktop".into()))
}
impl Default for DeviceInfo {
    fn default() -> Self {
        Self {
            alias: String::new(),
            version: "2.0".into(),
            device_model: String::new(),
            device_type: "desktop".into(),
            fingerprint: String::new(),
            port: PORT,
            protocol: "https".into(),
            download: false,
            // Current v2 multicast packets omit this legacy flag. An explicit
            // false remains respected; the default triggers a unicast reply.
            announce: true,
        }
    }
}
impl DeviceInfo {
    fn valid(&self) -> bool {
        !self.alias.trim().is_empty()
            && self.alias.len() <= 256
            && self.device_model.len() <= 256
            && self.device_type.len() <= 32
            && match self.protocol.as_str() {
                "https" => {
                    self.fingerprint.len() == 64
                        && self.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
                }
                "http" => !self.fingerprint.trim().is_empty() && self.fingerprint.len() <= 128,
                _ => false,
            }
            && self.version.starts_with("2.")
    }
}

pub struct Store {
    core: Result<Arc<Core>, String>,
}
struct Core {
    identity: Identity,
    client: reqwest::Client,
    state: Mutex<Snapshot>,
    emit: Arc<dyn Fn(Snapshot) + Send + Sync>,
    cancel: Mutex<Option<CancellationToken>>,
    active: AtomicBool,
    started: AtomicBool,
    start_lock: tokio::sync::Mutex<()>,
    port: std::sync::atomic::AtomicU16,
    udp: Mutex<Option<Arc<UdpSocket>>>,
    sequence: AtomicU64,
    last_progress: AtomicU64,
}
impl Store {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        // A damaged identity or unavailable data directory must not stop the notch.
        // Preserve the error so only Sharing reports that it cannot initialize.
        let core = (|| {
            let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let identity = Identity::load(&directory)?;
            let emitter = app.clone();
            Core::new(
                identity,
                Arc::new(move |state| {
                    let _ = emitter.emit("sharing-state", state);
                }),
            )
        })();
        Ok(Self { core })
    }
    fn core(&self) -> Result<Arc<Core>, String> {
        self.core.clone()
    }
    fn snapshot(&self) -> Snapshot {
        match &self.core {
            Ok(core) => core.snapshot(),
            Err(error) => Snapshot::unavailable(error.clone()),
        }
    }
}
impl Core {
    fn new(
        identity: Identity,
        emit: Arc<dyn Fn(Snapshot) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = http_client(&identity, None)?;
        let snapshot = Snapshot {
            revision: 0,
            alias: identity.alias.clone(),
            fingerprint: identity.fingerprint.clone(),
            server_running: false,
            discovering: false,
            diagnostic: String::new(),
            peers: vec![],
            transfer: Transfer::default(),
        };
        Ok(Arc::new(Self {
            identity,
            client,
            state: Mutex::new(snapshot),
            emit,
            cancel: Mutex::new(None),
            active: AtomicBool::new(false),
            started: AtomicBool::new(false),
            start_lock: tokio::sync::Mutex::new(()),
            port: std::sync::atomic::AtomicU16::new(PORT),
            udp: Mutex::new(None),
            sequence: AtomicU64::new(1),
            last_progress: AtomicU64::new(0),
        }))
    }
    fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn update(&self, change: impl FnOnce(&mut Snapshot)) -> Snapshot {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut state);
        state.revision = state.revision.saturating_add(1);
        let next = state.clone();
        (self.emit)(next.clone());
        next
    }
    fn upsert(&self, info: DeviceInfo, ip: IpAddr) -> bool {
        if !info.valid()
            || info
                .fingerprint
                .eq_ignore_ascii_case(&self.identity.fingerprint)
            || ip.is_unspecified()
            || ip.is_multicast()
        {
            return false;
        }
        let port = if info.port == 0 { PORT } else { info.port };
        let fingerprint = if info.protocol == "https" {
            info.fingerprint.to_ascii_lowercase()
        } else {
            info.fingerprint.clone()
        };
        // Port can change after a restart or when another app owns 53317.
        // Keep selection stable while replacing this peer's current endpoint.
        let id = format!("{}@{}", fingerprint, ip);
        self.update(|s| {
            let peer = Peer {
                id: id.clone(),
                alias: info.alias,
                device_model: info.device_model,
                device_type: info.device_type,
                ip_address: ip.to_string(),
                port,
                protocol: info.protocol,
                fingerprint,
                last_seen_ms: now_ms(),
            };
            if let Some(old) = s.peers.iter_mut().find(|p| p.id == id) {
                *old = peer;
            } else if s.peers.len() < 128 {
                s.peers.push(peer);
            }
            s.peers
                .sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
        });
        true
    }
    async fn start(self: &Arc<Self>) -> Result<(), String> {
        let _guard = self.start_lock.lock().await;
        if self.started.load(Ordering::Relaxed) {
            return Ok(());
        }
        let listener = match TcpListener::bind((Ipv4Addr::UNSPECIFIED, PORT)).await {
            Ok(v) => v,
            Err(_) => TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
                .await
                .map_err(|e| format!("Sharing tidak dapat membuka port jaringan: {e}"))?,
        };
        self.port.store(
            listener.local_addr().map_err(|e| e.to_string())?.port(),
            Ordering::Relaxed,
        );
        let cert = rustls::pki_types::CertificateDer::from(self.identity.disk.certificate.clone());
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(self.identity.disk.private_key.clone());
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key.into())
            .map_err(|e| e.to_string())?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        self.started.store(true, Ordering::Relaxed);
        self.update(|s| {
            s.server_running = true;
            s.diagnostic = String::new();
        });
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            let slots = Arc::new(tokio::sync::Semaphore::new(16));
            while let Ok((stream, remote)) = listener.accept().await {
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    continue;
                };
                let core = core.clone();
                let acceptor = acceptor.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok(stream)) =
                        tokio::time::timeout(Duration::from_secs(5), acceptor.accept(stream)).await
                    {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(10),
                            core.handle_registration(stream, remote.ip()),
                        )
                        .await;
                    }
                });
            }
        });
        match multicast_listener() {
            Ok(udp) => {
                let udp = Arc::new(udp);
                *self.udp.lock().unwrap() = Some(udp.clone());
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    let mut bytes = vec![0; 65536];
                    loop {
                        let Ok((len, remote)) = udp.recv_from(&mut bytes).await else {
                            break;
                        };
                        let Ok(info) = serde_json::from_slice::<DeviceInfo>(&bytes[..len]) else {
                            continue;
                        };
                        let announce = info.announce;
                        let port = if info.port == 0 { PORT } else { info.port };
                        let protocol = info.protocol.clone();
                        let expected = info.fingerprint.clone();
                        if core.upsert(info, remote.ip()) && announce {
                            let core = core.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = core
                                    .register(remote.ip(), port, Some(&protocol), Some(&expected))
                                    .await;
                            });
                        }
                    }
                });
            }
            Err(error) => {
                self.update(|s| {
                    s.diagnostic =
                        format!("Pencarian otomatis tidak tersedia: {error}. Gunakan IP perangkat.")
                });
            }
        }
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            tick.tick().await;
            loop {
                tick.tick().await;
                core.update(|s| {
                    s.peers
                        .retain(|p| now_ms().saturating_sub(p.last_seen_ms) < 300_000)
                });
                if core.active.load(Ordering::Relaxed) {
                    let _ = core.announce().await;
                }
            }
        });
        Ok(())
    }
    async fn announce(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.identity.dto(self.port.load(Ordering::Relaxed), true))
            .map_err(|e| e.to_string())?;
        let mut sent = 0;
        for ip in interfaces() {
            let Ok(socket) = socket2::Socket::new(
                socket2::Domain::IPV4,
                socket2::Type::DGRAM,
                Some(socket2::Protocol::UDP),
            ) else {
                continue;
            };
            if socket.bind(&SocketAddr::from((ip, 0)).into()).is_err() {
                continue;
            }
            let _ = socket.set_multicast_if_v4(&ip);
            let _ = socket.set_multicast_ttl_v4(2);
            let _ = socket.set_multicast_loop_v4(false);
            let _ = socket.set_nonblocking(true);
            let socket: std::net::UdpSocket = socket.into();
            let Ok(socket) = UdpSocket::from_std(socket) else {
                continue;
            };
            if socket.send_to(&bytes, (GROUP, PORT)).await.is_ok() {
                sent += 1;
            }
        }
        if sent == 0 {
            Err(
                "Tidak dapat mencari perangkat. Periksa koneksi Wi-Fi atau tambahkan IP perangkat."
                    .into(),
            )
        } else {
            Ok(())
        }
    }
    async fn register(
        &self,
        ip: IpAddr,
        port: u16,
        preferred: Option<&str>,
        expected: Option<&str>,
    ) -> Result<(), String> {
        let client = if expected.is_some_and(|v| !v.is_empty()) {
            http_client(&self.identity, expected)?
        } else {
            self.client.clone()
        };
        let protocols = match preferred {
            Some("http") => vec!["http"],
            Some("https") => vec!["https"],
            _ => vec!["https", "http"],
        };
        let host = if ip.is_ipv6() {
            format!("[{ip}]")
        } else {
            ip.to_string()
        };
        for protocol in protocols {
            let url = format!("{protocol}://{host}:{port}{API}/register");
            let request = client
                .post(url)
                .timeout(Duration::from_secs(4))
                .json(&self.identity.dto(self.port.load(Ordering::Relaxed), false));
            let Ok(response) = request.send().await else {
                continue;
            };
            if !response.status().is_success() {
                continue;
            }
            let tls_fingerprint = certificate_fingerprint(&response);
            let mut info: DeviceInfo = read_json(response).await?;
            if protocol == "https" {
                if let Some(actual) = tls_fingerprint {
                    if (!info.fingerprint.is_empty()
                        && !info.fingerprint.eq_ignore_ascii_case(&actual))
                        || expected
                            .is_some_and(|e| !e.is_empty() && !e.eq_ignore_ascii_case(&actual))
                    {
                        return Err(
                            "Identitas sertifikat perangkat berubah. Cari ulang perangkat.".into(),
                        );
                    }
                    info.fingerprint = actual;
                }
            }
            info.port = port;
            info.protocol = protocol.into();
            if self.upsert(info, ip) {
                return Ok(());
            } else {
                return Err("Respons perangkat LocalSend tidak valid".into());
            }
        }
        Err(format!(
            "Tidak ada LocalSend yang dapat dihubungi di {ip}:{port}"
        ))
    }
    async fn handle_registration<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        mut stream: S,
        ip: IpAddr,
    ) -> Result<(), String> {
        let request = read_request(&mut stream, true).await?;
        let (status, body) = match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/localsend/v2/info") => (
                200,
                serde_json::to_vec(&self.identity.dto(self.port.load(Ordering::Relaxed), false))
                    .unwrap(),
            ),
            ("POST", "/api/localsend/v2/register") => {
                match serde_json::from_slice::<DeviceInfo>(&request.body) {
                    Ok(info) if info.valid() => {
                        self.upsert(info, ip);
                        (
                            200,
                            serde_json::to_vec(
                                &self.identity.dto(self.port.load(Ordering::Relaxed), false),
                            )
                            .unwrap(),
                        )
                    }
                    _ => (400, vec![]),
                }
            }
            ("POST", "/api/localsend/v2/prepare-upload") | ("POST", "/api/localsend/v2/upload") => {
                (403, br#"{"message":"Notch is send-only"}"#.to_vec())
            }
            ("POST", "/api/localsend/v2/cancel") => (200, vec![]),
            _ => (404, vec![]),
        };
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            403 => "Forbidden",
            _ => "Not Found",
        };
        let header = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(header.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stream.write_all(&body).await.map_err(|e| e.to_string())?;
        stream.shutdown().await.map_err(|e| e.to_string())
    }
    fn prepare_files(&self, paths: Vec<String>) -> Result<Vec<SharedFile>, String> {
        if paths.is_empty() || paths.len() > FILE_LIMIT {
            return Err("Tambahkan 1–128 file untuk dikirim".into());
        }
        let mut additions: Vec<SharedFile> = Vec::new();
        for path in paths {
            if path.contains('\0') || path.len() > 32768 {
                return Err("Lokasi file tidak valid".into());
            }
            let path = PathBuf::from(path)
                .canonicalize()
                .map_err(|_| "File tidak ditemukan atau tidak dapat diakses")?;
            let metadata = path.metadata().map_err(|_| "File tidak dapat dibaca")?;
            if !metadata.is_file() {
                return Err(
                    "Sharing menerima file. Kompres folder menjadi ZIP terlebih dahulu.".into(),
                );
            }
            if additions
                .iter()
                .any(|file| file.path.eq_ignore_ascii_case(&path.to_string_lossy()))
            {
                continue;
            }
            additions.push(SharedFile {
                id: format!(
                    "f-{}-{}",
                    now_ms(),
                    self.sequence.fetch_add(1, Ordering::Relaxed)
                ),
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.to_string_lossy().into_owned(),
                size_bytes: metadata.len(),
            });
        }
        Ok(additions)
    }
}

fn interfaces() -> Vec<Ipv4Addr> {
    let mut ips = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| match iface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => {
                Some(ip)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        ips.push(Ipv4Addr::UNSPECIFIED);
    }
    ips
}
fn multicast_listener() -> Result<UdpSocket, String> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )
    .map_err(|e| e.to_string())?;
    socket.set_reuse_address(true).map_err(|e| e.to_string())?;
    socket
        .bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, PORT)).into())
        .map_err(|e| e.to_string())?;
    let mut joined = 0;
    for ip in interfaces() {
        if socket.join_multicast_v4(&GROUP, &ip).is_ok() {
            joined += 1;
        }
    }
    if joined == 0 {
        return Err("Tidak ada antarmuka multicast".into());
    }
    socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    UdpSocket::from_std(socket.into()).map_err(|e| e.to_string())
}
fn certificate_fingerprint(response: &reqwest::Response) -> Option<String> {
    response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .and_then(|tls| tls.peer_certificate())
        .map(fingerprint)
}
async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > JSON_LIMIT {
            return Err("Respons perangkat terlalu besar".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Respons perangkat LocalSend tidak valid".into())
}
struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}
async fn read_request<S: AsyncRead + Unpin>(
    stream: &mut S,
    reject_uploads: bool,
) -> Result<Request, String> {
    let mut bytes = Vec::new();
    let end = loop {
        if bytes.len() > 32768 {
            return Err("Header terlalu besar".into());
        }
        let mut part = [0; 1024];
        let count = stream.read(&mut part).await.map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Koneksi ditutup".into());
        }
        bytes.extend_from_slice(&part[..count]);
        if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..end]).map_err(|_| "Header tidak valid")?;
    let mut lines = headers.lines();
    let mut first = lines.next().ok_or("Request kosong")?.split_whitespace();
    let method = first.next().ok_or("Metode kosong")?.to_string();
    let path = first
        .next()
        .ok_or("Path kosong")?
        .split('?')
        .next()
        .unwrap_or_default()
        .to_string();
    let mut length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().map_err(|_| "Panjang tidak valid")?;
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                return Err("Encoding tidak didukung".into());
            }
        }
    }
    if reject_uploads
        && matches!(
            path.as_str(),
            "/api/localsend/v2/upload" | "/api/localsend/v2/prepare-upload"
        )
    {
        return Ok(Request {
            method,
            path,
            body: Vec::new(),
        });
    }
    if length > JSON_LIMIT {
        return Err("Request terlalu besar".into());
    }
    let mut body = bytes[end..].to_vec();
    while body.len() < length {
        let mut part = [0; 4096];
        let count = stream.read(&mut part).await.map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Request terputus".into());
        }
        body.extend_from_slice(&part[..count]);
    }
    body.truncate(length);
    Ok(Request { method, path, body })
}

fn endpoint(address: &str) -> Result<(IpAddr, u16), String> {
    let address = address.trim();
    if let Ok(socket) = address.parse::<SocketAddr>() {
        if !socket.ip().is_unspecified() && !socket.ip().is_multicast() && socket.port() > 0 {
            return Ok((socket.ip(), socket.port()));
        }
    }
    if let Ok(ip) = address.parse::<IpAddr>() {
        if !ip.is_unspecified() && !ip.is_multicast() {
            return Ok((ip, PORT));
        }
    }
    Err("Gunakan alamat IP perangkat, misalnya 192.168.1.50:53317".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    id: String,
    file_name: String,
    size: u64,
    file_type: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    session_id: String,
    files: HashMap<String, String>,
}
fn mime(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

impl Core {
    async fn cancel_remote(client: &reqwest::Client, peer: &Peer, session: Option<&str>) {
        let mut request = client.post(format!("{}{API}/cancel", peer.base()));
        if let Some(session) = session {
            request = request.query(&[("sessionId", session)]);
        }
        let _ = request.timeout(Duration::from_secs(2)).send().await;
    }
    async fn execute(
        self: Arc<Self>,
        peer: Peer,
        files: Vec<SharedFile>,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        let result = self.clone().transfer(peer, files, cancel.clone()).await;
        // Clear this run's cancellation handle before publishing a terminal
        // state that permits the user to start another transfer.
        *self.cancel.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Err(error) = &result {
            self.update(|s| {
                s.transfer.state = if cancel.is_cancelled() || error == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                s.transfer.message = if s.transfer.state == "cancelled" {
                    "Pengiriman dibatalkan".into()
                } else {
                    error.clone()
                };
            });
        } else {
            self.update(|s| s.transfer.state = "succeeded".into());
        }
        result
    }
    async fn transfer(
        self: Arc<Self>,
        peer: Peer,
        files: Vec<SharedFile>,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        let client = http_client(&self.identity, Some(&peer.fingerprint))?;
        let mut metadata = HashMap::new();
        let mut staged = HashMap::new();
        for file in files {
            let actual = tokio::fs::metadata(&file.path)
                .await
                .map_err(|_| format!("File {} tidak tersedia", file.name))?;
            if !actual.is_file() || actual.len() != file.size_bytes {
                return Err(format!(
                    "File {} berubah. Tambahkan ulang sebelum mengirim.",
                    file.name
                ));
            }
            metadata.insert(
                file.id.clone(),
                FileMeta {
                    id: file.id.clone(),
                    file_name: file.name.clone(),
                    size: file.size_bytes,
                    file_type: mime(&file.path).into(),
                },
            );
            staged.insert(file.id.clone(), file);
        }
        let response = tokio::select! {
            _ = cancel.cancelled() => {
                Self::cancel_remote(&client, &peer, None).await;
                return Err("cancelled".into());
            },
            response = client.post(format!("{}{API}/prepare-upload",peer.base()))
                .timeout(Duration::from_secs(120))
                .json(&serde_json::json!({"info":self.identity.dto(self.port.load(Ordering::Relaxed),false),"files":metadata}))
                .send() => response.map_err(|_|"Perangkat tidak dapat dihubungi. Periksa LocalSend dan jaringan.")?
        };
        if let Some(actual) = certificate_fingerprint(&response) {
            if !peer.fingerprint.is_empty() && !peer.fingerprint.eq_ignore_ascii_case(&actual) {
                return Err(
                    "Identitas sertifikat perangkat berubah. Cari ulang sebelum mengirim.".into(),
                );
            }
        }
        match response.status().as_u16() {
            403 => return Err("Penerima menolak kiriman".into()),
            204 => return Err("Penerima tidak menerima file dalam kiriman ini".into()),
            200 => {}
            status => return Err(format!("Penerima menolak permintaan ({status})")),
        }
        let prepared: Prepared = tokio::select! {
            _ = cancel.cancelled() => {
                Self::cancel_remote(&client, &peer, None).await;
                return Err("cancelled".into());
            },
            result = read_json(response) => result?
        };
        if prepared.session_id.is_empty() || prepared.session_id.len() > 1024 {
            return Err("Sesi penerima tidak valid".into());
        }
        let accepted = prepared
            .files
            .iter()
            .filter_map(|(id, token)| staged.get(id).map(|file| (file.clone(), token.clone())))
            .collect::<Vec<_>>();
        if accepted.is_empty() {
            Self::cancel_remote(&client, &peer, Some(&prepared.session_id)).await;
            return Err("Penerima tidak menerima file yang dipilih".into());
        }
        let skipped = staged.len() - accepted.len();
        let total = accepted
            .iter()
            .map(|(file, _)| file.size_bytes)
            .sum::<u64>();
        self.update(|s| {
            s.transfer.state = "sending".into();
            s.transfer.bytes_total = total;
            s.transfer.files_total = accepted.len() as u32;
            s.transfer.message = "Mengirim file…".into();
        });
        let result = self
            .upload_accepted(&client, &peer, &prepared.session_id, accepted, &cancel)
            .await;
        if result.is_err() {
            Self::cancel_remote(&client, &peer, Some(&prepared.session_id)).await;
        }
        result?;
        self.update(|s| {
            s.transfer.message = if skipped > 0 {
                format!(
                    "{} file terkirim; {skipped} file tidak diterima",
                    s.transfer.files_done
                )
            } else {
                format!("{} file terkirim", s.transfer.files_done)
            };
        });
        Ok(())
    }
    async fn upload_accepted(
        self: &Arc<Self>,
        client: &reqwest::Client,
        peer: &Peer,
        session: &str,
        accepted: Vec<(SharedFile, String)>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // Sequential bounded streams keep memory independent of file size.
        for (file, token) in accepted {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            let source = tokio::fs::File::open(&file.path)
                .await
                .map_err(|_| format!("{} tidak dapat dibaca", file.name))?;
            self.update(|s| s.transfer.current_file = file.name.clone());
            let core = self.clone();
            let read_cancel = cancel.clone();
            let stream = ReaderStream::with_capacity(source, 65536).map(move |chunk| {
                if read_cancel.is_cancelled() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "cancelled",
                    ));
                }
                if let Ok(bytes) = &chunk {
                    let mut state = core.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.transfer.bytes_done = state
                        .transfer
                        .bytes_done
                        .saturating_add(bytes.len() as u64)
                        .min(state.transfer.bytes_total);
                    let now = now_ms();
                    if now.saturating_sub(core.last_progress.load(Ordering::Relaxed)) >= 80 {
                        core.last_progress.store(now, Ordering::Relaxed);
                        state.revision += 1;
                        (core.emit)(state.clone());
                    }
                }
                chunk
            });
            let request = client
                .post(format!("{}{API}/upload", peer.base()))
                .query(&[
                    ("sessionId", session),
                    ("fileId", file.id.as_str()),
                    ("token", token.as_str()),
                ])
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .header(reqwest::header::CONTENT_LENGTH, file.size_bytes)
                .timeout(Duration::from_secs(1800))
                .body(reqwest::Body::wrap_stream(stream));
            let response = tokio::select! {_ = cancel.cancelled()=>return Err("cancelled".into()), response=request.send()=>response.map_err(|_|format!("Transfer {} terputus",file.name))?};
            if !response.status().is_success() {
                return Err(format!(
                    "Gagal mengirim {} ({})",
                    file.name,
                    response.status().as_u16()
                ));
            }
            if let Some(actual) = certificate_fingerprint(&response) {
                if !peer.fingerprint.is_empty() && !peer.fingerprint.eq_ignore_ascii_case(&actual) {
                    return Err("Identitas penerima berubah saat transfer".into());
                }
            }
            self.update(|s| {
                s.transfer.files_done += 1;
            });
        }
        Ok(())
    }
}

#[tauri::command]
pub fn sharing_snapshot(store: State<'_, Store>) -> Snapshot {
    store.snapshot()
}
#[tauri::command]
pub async fn sharing_active(active: bool, store: State<'_, Store>) -> Result<Snapshot, String> {
    let core = store.core()?;
    core.active.store(active, Ordering::Relaxed);
    if active {
        core.start().await?;
        let _ = core.announce().await;
    }
    Ok(core.snapshot())
}
#[tauri::command]
pub async fn sharing_refresh(store: State<'_, Store>) -> Result<Snapshot, String> {
    let core = store.core()?;
    core.start().await?;
    core.update(|s| {
        s.discovering = true;
        s.diagnostic = "Mencari perangkat…".into();
    });
    let result = core.announce().await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    Ok(core.update(|s|{s.discovering=false;s.peers.retain(|p|now_ms().saturating_sub(p.last_seen_ms)<300_000);s.diagnostic=match result{Ok(_)=>if s.peers.is_empty(){"Belum ada perangkat. Buka LocalSend pada perangkat tujuan di jaringan yang sama.".into()}else{String::new()},Err(error)=>error};}))
}
#[tauri::command]
pub async fn sharing_add_peer(
    address: String,
    store: State<'_, Store>,
) -> Result<Snapshot, String> {
    let core = store.core()?;
    let (ip, port) = endpoint(&address)?;
    core.start().await?;
    core.register(ip, port, None, None).await?;
    Ok(core.snapshot())
}
#[tauri::command]
pub fn sharing_cancel(store: State<'_, Store>) -> Snapshot {
    let Ok(core) = store.core() else {
        return store.snapshot();
    };
    if let Some(cancel) = core
        .cancel
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        cancel.cancel();
    }
    core.snapshot()
}
fn tray_paths(
    snapshot: crate::tray::TraySnapshot,
    ids: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let eligible = |item: &&crate::tray::TrayItem| item.kind == "file" && item.available;
    let files = match ids {
        Some(ids) => {
            if ids.is_empty() || ids.len() > FILE_LIMIT {
                return Err("Pilih 1–128 file dari Tray".into());
            }
            let mut files = Vec::new();
            for id in ids {
                let item = snapshot
                    .items
                    .iter()
                    .find(|item| item.id == id)
                    .filter(eligible)
                    .ok_or("Pilihan file tidak tersedia. Periksa kembali file di Tray.")?;
                files.push(item.value.clone());
            }
            files
        }
        None => snapshot
            .items
            .iter()
            .filter(eligible)
            .map(|item| item.value.clone())
            .collect(),
    };
    if files.is_empty() {
        return Err("Tambahkan file ke Tray sebelum mengirim".into());
    }
    Ok(files)
}

#[tauri::command]
pub async fn sharing_send(
    peer_id: String,
    tray_ids: Option<Vec<String>>,
    tray_store: State<'_, crate::tray::Store>,
    store: State<'_, Store>,
) -> Result<Snapshot, String> {
    let core = store.core()?;
    // Tray is the only file store. Resolve it when Send is explicitly clicked;
    // the transfer owns a frozen metadata snapshot from this point onward.
    let paths = tray_paths(crate::tray::tray_snapshot(tray_store)?, tray_ids)?;
    let prepare = core.clone();
    let files = tauri::async_runtime::spawn_blocking(move || prepare.prepare_files(paths))
        .await
        .map_err(|e| e.to_string())??;
    core.start().await?;
    let cancel = CancellationToken::new();
    let peer = {
        let mut state = core.state.lock().map_err(|_| "Sharing tidak tersedia")?;
        if state.transfer.busy() {
            return Err("Transfer lain masih berjalan".into());
        }
        let peer = state
            .peers
            .iter()
            .find(|p| p.id == peer_id)
            .cloned()
            .ok_or("Pilih perangkat yang tersedia")?;
        state.transfer = Transfer {
            state: "waiting".into(),
            peer_id: peer.id.clone(),
            peer_name: peer.alias.clone(),
            files_total: files.len() as u32,
            bytes_total: files.iter().map(|f| f.size_bytes).sum(),
            message: "Menunggu persetujuan penerima…".into(),
            ..Default::default()
        };
        state.revision += 1;
        *core.cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
        (core.emit)(state.clone());
        peer
    };
    let task = core.clone();
    tauri::async_runtime::spawn(async move {
        let _ = task.execute(peer, files, cancel).await;
    });
    Ok(core.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Notify;
    static TEST_ID: AtomicU64 = AtomicU64::new(1);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "notch-sharing-test-{}-{}",
                std::process::id(),
                TEST_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Ok(entries) = std::fs::read_dir(&self.0) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    fn core(directory: &Path) -> (Arc<Core>, Arc<Mutex<Vec<Snapshot>>>) {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let collect = updates.clone();
        let core = Core::new(
            Identity::load(directory).unwrap(),
            Arc::new(move |s| collect.lock().unwrap().push(s)),
        )
        .unwrap();
        (core, updates)
    }
    async fn reply<S: AsyncWrite + Unpin>(stream: &mut S, status: u16, body: &[u8]) {
        let headers = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(headers.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.shutdown().await;
    }
    async fn receiver(
        mode: &'static str,
    ) -> (
        Peer,
        CancellationToken,
        Arc<Mutex<Vec<(String, Vec<u8>)>>>,
        Arc<Notify>,
    ) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let uploading = Arc::new(Notify::new());
        let upload = uploading.clone();
        tokio::spawn(async move {
            loop {
                let stream =
                    tokio::select! {_=stopping.cancelled()=>break,result=listener.accept()=>result};
                let Ok((mut stream, _)) = stream else {
                    break;
                };
                let seen = seen.clone();
                let uploading = upload.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut stream, false).await.unwrap();
                    seen.lock()
                        .unwrap()
                        .push((request.path.clone(), request.body.clone()));
                    if request.path.ends_with("/prepare-upload") {
                        if mode == "pending" {
                            uploading.notify_one();
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        }
                        if mode == "reject" {
                            reply(&mut stream, 403, b"{}").await;
                            return;
                        }
                        let body: serde_json::Value =
                            serde_json::from_slice(&request.body).unwrap();
                        let files = body["files"].as_object().unwrap();
                        let mut tokens = serde_json::Map::new();
                        if mode == "unknown" {
                            tokens.insert("not-requested".into(), serde_json::json!("token"));
                        } else {
                            for id in
                                files
                                    .keys()
                                    .take(if mode == "partial" { 1 } else { usize::MAX })
                            {
                                tokens.insert(id.clone(), serde_json::json!("token"));
                            }
                        }
                        reply(&mut stream,200,serde_json::to_vec(&serde_json::json!({"sessionId":"session with spaces","files":tokens})).unwrap().as_slice()).await;
                    } else if request.path.ends_with("/upload") {
                        uploading.notify_one();
                        if mode == "delay" {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        }
                        reply(&mut stream, 200, b"").await;
                    } else {
                        reply(&mut stream, 200, b"{}").await;
                    }
                });
            }
        });
        (
            Peer {
                id: "mock".into(),
                alias: "Loopback receiver".into(),
                device_model: "Test".into(),
                device_type: "desktop".into(),
                ip_address: "127.0.0.1".into(),
                port,
                protocol: "http".into(),
                fingerprint: String::new(),
                last_seen_ms: now_ms(),
            },
            stop,
            requests,
            uploading,
        )
    }
    #[test]
    fn send_resolves_only_current_tray_files_and_never_expands_stale_selection() {
        let item = |id: &str, kind: &str, available: bool| crate::tray::TrayItem {
            id: id.into(),
            kind: kind.into(),
            available,
            name: id.into(),
            value: format!("C:\\Review\\{id}"),
            extension: String::new(),
            size_bytes: Some(5),
            added_at_ms: 0,
        };
        let mut tray = crate::tray::TraySnapshot {
            items: vec![
                item("one.txt", "file", true),
                item("two.txt", "file", true),
                item("folder", "folder", true),
                item("link", "link", true),
                item("missing.txt", "file", false),
            ],
            revision: 1,
        };
        assert_eq!(tray_paths(tray.clone(), None).unwrap().len(), 2);
        let selected = Some(vec!["two.txt".into()]);
        assert_eq!(
            tray_paths(tray.clone(), selected.clone()).unwrap(),
            vec!["C:\\Review\\two.txt"]
        );
        for id in ["folder", "link", "missing.txt", "removed.txt"] {
            assert!(tray_paths(tray.clone(), Some(vec![id.into()])).is_err());
        }
        assert!(tray_paths(tray.clone(), Some(vec![])).is_err());
        tray.items.retain(|item| item.id != "two.txt");
        assert!(tray_paths(tray.clone(), selected).is_err());
        assert_eq!(tray_paths(tray.clone(), None).unwrap().len(), 1);
        tray.items.clear();
        assert!(tray_paths(tray, None).is_err());
    }

    #[test]
    fn endpoint_validation_handles_ipv6_and_identity_is_stable() {
        assert_eq!(
            endpoint("[::1]:53318").unwrap(),
            ("::1".parse().unwrap(), 53318)
        );
        assert_eq!(endpoint("192.168.1.5").unwrap().1, PORT);
        assert!(endpoint("https://example.com").is_err());
        assert!(endpoint("0.0.0.0:123").is_err());
        let dir = Scratch::new();
        let a = Identity::load(&dir.0).unwrap();
        let b = Identity::load(&dir.0).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.fingerprint.len(), 64);
    }
    #[test]
    fn current_multicast_accepts_http_identity_nullable_metadata_and_missing_announce() {
        let info: DeviceInfo = serde_json::from_value(serde_json::json!({
            "alias": "HTTP receiver", "version": "2.2", "deviceModel": null,
            "deviceType": null, "fingerprint": "Random Identity UUID-123",
            "protocol": "http", "port": 53317
        }))
        .unwrap();
        assert!(info.valid());
        assert!(info.announce);
        assert_eq!(info.device_model, "");
        assert_eq!(info.device_type, "desktop");
        let explicit: DeviceInfo = serde_json::from_value(serde_json::json!({
            "alias":"HTTP receiver", "protocol":"http", "fingerprint":"random string",
            "announce":false
        }))
        .unwrap();
        assert!(explicit.valid());
        assert!(!explicit.announce);
        let invalid_tls = DeviceInfo {
            protocol: "https".into(),
            ..info
        };
        assert!(!invalid_tls.valid());
    }
    #[test]
    fn peer_restart_updates_port_without_duplicating_or_losing_selection() {
        let dir = Scratch::new();
        let (core, _) = core(&dir.0);
        let ip = "192.168.1.50".parse().unwrap();
        let mut info = DeviceInfo {
            alias: "Receiver".into(),
            fingerprint: "Ab".repeat(32),
            ..Default::default()
        };
        assert!(core.upsert(info.clone(), ip));
        let original_id = core.snapshot().peers[0].id.clone();
        info.port = 53318;
        info.fingerprint = info.fingerprint.to_ascii_uppercase();
        assert!(core.upsert(info, ip));
        let snapshot = core.snapshot();
        assert_eq!(snapshot.peers.len(), 1);
        assert_eq!(snapshot.peers[0].id, original_id);
        assert_eq!(snapshot.peers[0].port, 53318);
    }
    #[tokio::test]
    async fn streamed_upload_is_acknowledged_and_original_is_unchanged() {
        let dir = Scratch::new();
        let path = dir.0.join("original.bin");
        let bytes = (0..131072).map(|v| (v % 251) as u8).collect::<Vec<_>>();
        std::fs::write(&path, &bytes).unwrap();
        let (core, updates) = core(&dir.0);
        let files = core
            .prepare_files(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        let (peer, stop, requests, _) = receiver("normal").await;
        core.clone()
            .execute(peer, files, CancellationToken::new())
            .await
            .unwrap();
        stop.cancel();
        let snapshot = core.snapshot();
        assert_eq!(snapshot.transfer.state, "succeeded");
        assert_eq!(snapshot.transfer.files_done, 1);
        assert_eq!(snapshot.transfer.bytes_done, bytes.len() as u64);
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .find(|(path, _)| path.ends_with("/upload"))
                .unwrap()
                .1,
            bytes
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert!(
            updates
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.transfer.state == "sending")
        );
    }
    #[tokio::test]
    async fn refusal_or_unknown_file_tokens_never_upload_or_report_success() {
        let dir = Scratch::new();
        let path = dir.0.join("test.txt");
        std::fs::write(&path, b"hello").unwrap();
        let (core, _) = core(&dir.0);
        let files = core
            .prepare_files(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        for mode in ["reject", "unknown"] {
            let (peer, stop, requests, _) = receiver(mode).await;
            assert!(
                core.clone()
                    .execute(peer, files.clone(), CancellationToken::new())
                    .await
                    .is_err()
            );
            stop.cancel();
            assert_eq!(core.snapshot().transfer.state, "failed");
            assert!(
                !requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(path, _)| path.ends_with("/upload"))
            );
        }
    }
    #[tokio::test]
    async fn cancellation_during_upload_stays_cancelled_and_notifies_receiver() {
        let dir = Scratch::new();
        let path = dir.0.join("test.txt");
        std::fs::write(&path, b"hello").unwrap();
        let (core, _) = core(&dir.0);
        let files = core
            .prepare_files(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        let (peer, stop, requests, uploading) = receiver("delay").await;
        let token = CancellationToken::new();
        let task_core = core.clone();
        let task_token = token.clone();
        let task = tokio::spawn(async move { task_core.execute(peer, files, task_token).await });
        tokio::time::timeout(Duration::from_secs(3), uploading.notified())
            .await
            .unwrap();
        token.cancel();
        assert!(task.await.unwrap().is_err());
        stop.cancel();
        assert_eq!(core.snapshot().transfer.state, "cancelled");
        assert!(
            requests
                .lock()
                .unwrap()
                .iter()
                .any(|(path, _)| path.ends_with("/cancel"))
        );
    }
    #[tokio::test]
    async fn cancelling_pending_approval_notifies_receiver_without_uploading() {
        let dir = Scratch::new();
        let path = dir.0.join("test.txt");
        std::fs::write(&path, b"hello").unwrap();
        let (core, _) = core(&dir.0);
        let files = core
            .prepare_files(vec![path.to_string_lossy().into_owned()])
            .unwrap();
        let (peer, stop, requests, preparing) = receiver("pending").await;
        let token = CancellationToken::new();
        let task_core = core.clone();
        let task_token = token.clone();
        let task = tokio::spawn(async move { task_core.execute(peer, files, task_token).await });
        tokio::time::timeout(Duration::from_secs(3), preparing.notified())
            .await
            .unwrap();
        token.cancel();
        assert!(task.await.unwrap().is_err());
        stop.cancel();
        assert_eq!(core.snapshot().transfer.state, "cancelled");
        let requests = requests.lock().unwrap();
        assert!(requests.iter().any(|(path, _)| path.ends_with("/cancel")));
        assert!(!requests.iter().any(|(path, _)| path.ends_with("/upload")));
    }
    #[tokio::test]
    async fn tls_fingerprint_mismatch_is_rejected_before_http_bytes() {
        let dir = Scratch::new();
        let identity = Identity::load(&dir.0).unwrap();
        let client = http_client(&identity, Some(&"00".repeat(32))).unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![rustls::pki_types::CertificateDer::from(
                    identity.disk.certificate.clone(),
                )],
                rustls::pki_types::PrivatePkcs8KeyDer::from(identity.disk.private_key.clone())
                    .into(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            acceptor.accept(stream).await.is_err()
        });
        assert!(
            client
                .get(format!("https://{address}/api/localsend/v2/info"))
                .send()
                .await
                .is_err()
        );
        assert!(task.await.unwrap());
    }
    #[tokio::test]
    async fn https_callback_serves_metadata_and_refuses_incoming_upload_without_body() {
        let dir = Scratch::new();
        let (core, _) = core(&dir.0);
        let (mut client, server) = tokio::io::duplex(4096);
        let callback = core.clone();
        let task = tokio::spawn(async move {
            callback
                .handle_registration(server, IpAddr::V4(Ipv4Addr::LOCALHOST))
                .await
        });
        client.write_all(b"POST /api/localsend/v2/upload?sessionId=x HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();
        assert!(response.starts_with(b"HTTP/1.1 403"));

        let (mut client, server) = tokio::io::duplex(4096);
        let callback = core.clone();
        let task = tokio::spawn(async move {
            callback
                .handle_registration(server, IpAddr::V4(Ipv4Addr::LOCALHOST))
                .await
        });
        client
            .write_all(b"GET /api/localsend/v2/info HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        task.await.unwrap().unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert!(
            String::from_utf8(response)
                .unwrap()
                .contains(&core.identity.fingerprint)
        );
    }
    #[tokio::test]
    async fn pinned_https_presents_our_client_certificate() {
        let sender_dir = Scratch::new();
        let receiver_dir = Scratch::new();
        let sender = Identity::load(&sender_dir.0).unwrap();
        let receiver = Identity::load(&receiver_dir.0).unwrap();
        let expected_sender = sender.fingerprint.clone();
        let expected_receiver = receiver.fingerprint.clone();
        let client =
            http_client(&sender, Some(&receiver.fingerprint.to_ascii_uppercase())).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                sender.disk.certificate,
            ))
            .unwrap();
        let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
            .build()
            .unwrap();
        let config = rustls::ServerConfig::builder()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![rustls::pki_types::CertificateDer::from(
                    receiver.disk.certificate,
                )],
                rustls::pki_types::PrivatePkcs8KeyDer::from(receiver.disk.private_key).into(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = acceptor.accept(stream).await.unwrap();
            let cert = &stream.get_ref().1.peer_certificates().unwrap()[0];
            assert_eq!(fingerprint(cert.as_ref()), expected_sender);
            read_request(&mut stream, false).await.unwrap();
            reply(&mut stream, 200, b"{}").await;
        });
        let response = client
            .get(format!("https://{address}/api/localsend/v2/info"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            certificate_fingerprint(&response).as_deref(),
            Some(expected_receiver.as_str())
        );
        task.await.unwrap();
    }
}
