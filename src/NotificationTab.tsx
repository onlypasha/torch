import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { NotificationModel } from "./useNotifications";
import { notificationAge } from "./notifications";
import type { NotificationItem } from "./notifications";
import { NotificationAvatar } from "./NotificationAvatar";
import "./NotificationTab.css";

function Bell({ size = 22 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 20h4" /></svg>;
}
function RefreshIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 5a5.5 5.5 0 1 0 .2 5M13 2v4H9" /></svg>;
}
function CloseIcon() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5 12.5 12.5m0-9-9 9" /></svg>;
}
function NotificationFace({ item, now }: { item: NotificationItem; now: number }) {
  const reducedMotion = useReducedMotion();
  return <motion.span className="notification-face" key={`${item.id}:${item.createdAtMs}`}
    initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }}
    transition={reducedMotion ? { duration: .1 } : { type: "spring", bounce: 0, duration: .3 }}>
    <NotificationAvatar item={item} />
    <span className="notification-copy">
      <span className="notification-meta"><strong>{item.appName}</strong><time dateTime={new Date(item.createdAtMs).toISOString()}>{notificationAge(item.createdAtMs, now)}</time></span>
      <span className="notification-title" title={item.title || item.appName}>{item.title || item.appName}</span>
      {item.body && <span className="notification-body" title={item.body}>{item.body}</span>}
    </span>
  </motion.span>;
}

export function NotificationInterruption({ item, queued, onNext, onDismiss, onOpen }: {
  item: NotificationItem; queued: number; onNext: () => void; onDismiss: () => void; onOpen: () => void;
}) {
  return <section className="notification-interruption" aria-label={`Notifikasi baru dari ${item.appName}`}>
    <div className="notification-live">
      <button className="notification-open" type="button" title={`Buka ${item.appName}`} aria-label={`Buka ${item.title} dari ${item.appName}`} onClick={onOpen}>
        <NotificationFace item={item} now={Date.now()} />
      </button>
      <div className="notification-live-controls">
        {queued > 0 && <button className="notification-next" type="button" aria-label={`Tampilkan notifikasi berikutnya, ${queued} lainnya`} onClick={onNext}>+{queued}</button>}
        <button className="notification-interruption-dismiss" type="button" title="Tutup tampilan notifikasi" aria-label="Tutup tampilan notifikasi" onClick={onDismiss}><CloseIcon /></button>
      </div>
    </div>
  </section>;
}

export function NotificationTab({ notifications }: { notifications: NotificationModel }) {
  const { items, access, error, message, pending, perform } = notifications;
  const [now, setNow] = useState(Date.now());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [order, setOrder] = useState<number[]>([]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!filterOpen) return;
    filterPanel.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      if (!filterPanel.current?.contains(event.target as Node) && !filterButton.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setFilterOpen(false); filterButton.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [filterOpen]);
  useEffect(() => {
    const ids = items.map((item) => item.id);
    setOrder((previous) => {
      const kept = previous.filter((id) => ids.includes(id));
      if (!kept.length) return ids;
      const arriving = ids.filter((id) => !kept.includes(id)).reverse();
      return arriving.length || kept.length !== previous.length ? [...kept, ...arriving] : previous;
    });
  }, [items]);

  const allowed = access === "allowed";
  const active = items.find((item) => item.id === order[0]) ?? items[0];
  const showItem = !!active && (allowed || access === "error");
  const queued = Math.max(0, items.length - 1);
  const showNext = () => setOrder((previous) => {
    const ids = previous.filter((id) => items.some((item) => item.id === id));
    return ids.length > 1 ? [...ids.slice(1), ids[0]] : ids;
  });
  const emptyTitle = allowed
    ? notifications.filter.mode === "selected" ? "Tidak ada notifikasi dari pilihan ini" : "Tidak ada notifikasi aktif"
    : access === "unknown" ? "Aktifkan notifikasi Windows" : access === "denied" ? "Akses notifikasi ditolak" : "Notifikasi belum tersedia";
  const emptyDetail = allowed
    ? notifications.filter.mode === "selected" ? "Ubah pilihan aplikasi untuk melihat notifikasi lain." : "Notifikasi baru akan muncul di sini."
    : error || message || "Izinkan NotchApp membaca notifikasi Windows.";

  return <section className="notch-notifications" aria-label="Notifikasi Windows" aria-busy={pending}>
    <header className="notification-heading">
      <span>Notifikasi{items.length > 0 && <small>{items.length}</small>}</span>
      <div className="notification-actions">
        {allowed && <button ref={filterButton} type="button" className="notification-filter-button" aria-label="Saring aplikasi" aria-controls="notification-source-filter" aria-expanded={filterOpen} onClick={() => setFilterOpen((value) => !value)}>Aplikasi</button>}
        {allowed && items.length > 0 && <button type="button" disabled={pending} onClick={() => void perform("notifications_clear", { ids: items.map((item) => item.id) })}>Bersihkan</button>}
        {allowed && <button type="button" className="notification-refresh" title="Segarkan notifikasi" aria-label="Segarkan notifikasi" disabled={pending} onClick={() => void perform("notifications_refresh")}><RefreshIcon /></button>}
      </div>
    </header>

    {showItem ? <div className="notification-live" role="group" aria-label="Notifikasi aktif">
      <button className="notification-open notification-item" type="button" title={`Buka ${active.appName}`} aria-label={`Buka ${active.title} dari ${active.appName}`} disabled={pending || !allowed} onClick={() => void perform("notifications_open", { id: active.id })}>
        <NotificationFace item={active} now={now} />
      </button>
      <div className="notification-live-controls">
        {queued > 0 && <button className="notification-next" type="button" aria-label={`Tampilkan notifikasi berikutnya, ${queued} lainnya`} title="Notifikasi berikutnya" onClick={showNext}>+{queued}</button>}
        <button className="notification-dismiss" type="button" title="Hapus notifikasi" aria-label={`Hapus notifikasi dari ${active.appName}`} disabled={pending || !allowed} onClick={() => void perform("notifications_dismiss", { id: active.id })}><CloseIcon /></button>
      </div>
    </div> : <div className="notification-empty" data-access={access}>
      <span className="notification-empty-icon"><Bell /></span>
      <span className="notification-empty-copy"><strong>{emptyTitle}</strong><small>{emptyDetail}</small></span>
      {access === "unknown" && <button type="button" className="notification-primary-action" disabled={pending} onClick={() => void perform("notifications_request_access")}>{pending ? "Memeriksa…" : "Berikan akses"}</button>}
      {access === "denied" && <button type="button" className="notification-primary-action" onClick={() => void perform("notifications_settings")}>Pengaturan Windows</button>}
      {access === "error" && <button type="button" className="notification-primary-action" disabled={pending} onClick={() => void perform("notifications_refresh")}>Coba lagi</button>}
    </div>}

    {(error || (access === "error" && showItem && message)) && showItem && <div className="notification-error" role="alert">{error || message}</div>}
    <AnimatePresence>{allowed && filterOpen && <motion.div ref={filterPanel} id="notification-source-filter" className="notification-filter-panel" role="group" aria-label="Saring aplikasi notifikasi"
      initial={{ opacity: 0, scale: reducedMotion ? 1 : .96, y: reducedMotion ? 0 : -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: reducedMotion ? 1 : .96, y: reducedMotion ? 0 : -4 }}
      transition={reducedMotion ? { duration: .1 } : { type: "spring", bounce: 0, duration: .28 }}>
      <div className="notification-filter-header"><strong>Tampilkan dari</strong><button type="button" aria-label="Tutup saringan" onClick={() => { setFilterOpen(false); filterButton.current?.focus(); }}><CloseIcon /></button></div>
      <label><input type="radio" name="notification-source" checked={notifications.filter.mode === "all"} onChange={() => notifications.setFilter({ ...notifications.filter, mode: "all" })} /> Semua aplikasi</label>
      <label><input type="radio" name="notification-source" checked={notifications.filter.mode === "selected"} onChange={() => notifications.setFilter({ ...notifications.filter, mode: "selected" })} /> Aplikasi pilihan</label>
      {notifications.filter.mode === "selected" && <div className="notification-app-options">
        {[...new Map(notifications.allItems.map((item) => [item.appId, item.appName])).entries()].map(([appId, appName]) => <label key={appId}>
          <input type="checkbox" checked={notifications.filter.appIds.includes(appId)} onChange={() => notifications.setFilter((previous) => ({ ...previous, appIds: previous.appIds.includes(appId) ? previous.appIds.filter((id) => id !== appId) : [...previous.appIds, appId] }))} /> {appName}
        </label>)}
        {!notifications.allItems.length && <small>Aplikasi muncul setelah mengirim notifikasi.</small>}
      </div>}
    </motion.div>}</AnimatePresence>
  </section>;
}
