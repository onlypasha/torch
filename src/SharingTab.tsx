import type { SharingModel } from "./useSharing";
import type { TrayModel } from "./useTray";
import { sharingBytes, sharingTrayFiles, transferFraction } from "./sharing";
import "./SharingTab.css";

function DeviceIcon({ mobile = false }: { mobile?: boolean }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mobile ? <><rect x="6.5" y="2" width="11" height="20" rx="3" /><path d="M10 5h4M11 19h2" /></>
      : <><rect x="2" y="3" width="20" height="14" rx="2.5" /><path d="M8 21h8M12 17v4" /></>}
  </svg>;
}
function RefreshIcon() { return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 5a5.5 5.5 0 1 0 .2 5M13 2v4H9" /></svg>; }

export function SharingTab({ sharing, tray, onOpenTray }: {
  sharing: SharingModel; tray: TrayModel; onOpenTray: () => void;
}) {
  const { peers, busy, transfer, selectedTrayIds } = sharing;
  const files = sharingTrayFiles(tray.items, selectedTrayIds);
  const selectionMissing = selectedTrayIds !== null && files.length !== new Set(selectedTrayIds).size;
  const total = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  const fraction = transferFraction(transfer);
  return <section className="notch-sharing" aria-label="Berbagi dengan LocalSend" aria-busy={sharing.pending}>
    <div className="sharing-source">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M2 4h5l1.5 2H14v7H2Z" /></svg>
      <span className="sharing-source-label">{busy ? `${transfer.filesTotal} file dalam kiriman` : selectionMissing ? "Pilihan Tray tidak tersedia" : files.length
        ? `${files.length} file ${selectedTrayIds === null ? "dari Tray" : "dipilih dari Tray"}`
        : "Belum ada file di Tray"}</span>
      {(busy || files.length > 0) && <small>{sharingBytes(busy ? transfer.bytesTotal : total)}</small>}
      {!busy && selectedTrayIds !== null && <button type="button" onClick={() => sharing.selectTrayFiles(null)}>Semua file</button>}
      <button type="button" onClick={onOpenTray}>Buka Tray</button>
    </div>
    <div className="sharing-devices">
      <header className="sharing-heading"><span>{busy ? "Transfer" : "Perangkat sekitar"}</span>
        <div className="sharing-header-tools">
          <small className="sharing-alias" title={sharing.alias}>{sharing.alias}</small>
          {!busy && <><button type="button" className="sharing-ip" title="Salin IP perangkat, lalu klik untuk menambahkan" aria-label="Tambah perangkat dari IP di clipboard" disabled={sharing.pending} onClick={() => void sharing.perform("sharing_add_peer_clipboard")}>IP</button>
            <button type="button" className={sharing.discovering ? "sharing-refresh-active" : ""} aria-label="Cari perangkat" title="Cari perangkat" disabled={sharing.pending || sharing.discovering} onClick={() => void sharing.perform("sharing_refresh")}><RefreshIcon /></button></>}
        </div>
      </header>
      {busy ? <div className="sharing-transfer" data-state={transfer.state}>
        <div className="sharing-transfer-peer"><DeviceIcon /><span>{transfer.peerName}<small>{transfer.state === "waiting" ? "Menunggu persetujuan penerima…" : transfer.currentFile || "Mengirim file…"}</small></span></div>
        <div className="sharing-transfer-status">
          <div className="sharing-progress" role="progressbar" aria-label="Progres transfer" aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer.state === "sending" ? Math.round(fraction * 100) : undefined} data-waiting={transfer.state === "waiting"}><span style={{ width: `${fraction * 100}%` }} /></div>
          <div className="sharing-transfer-footer"><span>{sharingBytes(transfer.bytesDone)} / {sharingBytes(transfer.bytesTotal)}</span><button type="button" onClick={() => void sharing.perform("sharing_cancel")}>Batal</button></div>
        </div>
      </div> : <>
        {peers.length ? <div className="sharing-peer-list" role="list" aria-label="Perangkat LocalSend">
          {peers.map((peer) => <div className="sharing-peer" role="listitem" key={peer.id}>
            <DeviceIcon mobile={peer.deviceType === "mobile"} />
            <span title={`${peer.deviceModel} ${peer.ipAddress}`}>{peer.alias}<small>{peer.ipAddress}</small></span>
            <button type="button" disabled={!files.length || selectionMissing || tray.pending || sharing.pending} aria-label={`Kirim ke ${peer.alias}`} onClick={() => void sharing.perform("sharing_send", { peerId: peer.id, trayIds: selectedTrayIds })}>Kirim<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2 6h8M6 2l4 4-4 4" /></svg></button>
          </div>)}
        </div> : <div className="sharing-peer-empty"><DeviceIcon /><span>{sharing.discovering ? "Mencari perangkat…" : "Belum ada perangkat"}</span><small>Buka LocalSend di Wi-Fi yang sama</small></div>}
        {transfer.state !== "idle" && <div className="sharing-result" data-state={transfer.state} role="status">{transfer.message || (transfer.state === "succeeded" ? "File terkirim" : "Transfer selesai")}</div>}
      </>}
    </div>
    {(sharing.error || sharing.diagnostic) && !busy && <div className="sharing-notice" data-error={!!sharing.error} role={sharing.error ? "alert" : "status"}>{sharing.error || sharing.diagnostic}</div>}
  </section>;
}
