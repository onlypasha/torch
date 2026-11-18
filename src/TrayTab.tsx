import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TrayModel } from "./useTray";
import { selectTrayItem, trayDetail } from "./tray";
import type { TrayItem } from "./tray";
import { invoke } from "@tauri-apps/api/core";
import "./TrayTab.css";

const GLYPHS = {
  share: "M2 8h11M8 3l5 5-5 5",
  open: "M9 2h5v5M14 2 7 9M6 3H2v11h11v-4", reveal: "M2 4h5l1.5 2H14v7H2Z",
  copy: "M6 6h8v8H6ZM3 10H2V2h8v1", remove: "M4 4l8 8M12 4l-8 8",
  clear: "M2 4h12M6 2h4M4 4l1 10h6l1-10M7 7v4M9 7v4",
} as const;
function Icon({ name }: { name: keyof typeof GLYPHS }) {
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
}
function Tool({ name, label, disabled, onClick }: { name: keyof typeof GLYPHS; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="tray-tool" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon name={name} /></button>;
}
function FileGlyph({ item }: { item: TrayItem }) {
  let body: ReactNode;
  if (item.kind === "folder") body = <path d="M5 10h12l4 4h22v27H5Z" />;
  else if (item.kind === "link") body = <><path d="m20 30 10-10M24 17l4-4a8 8 0 0 1 11 11l-5 5M24 31l-4 4A8 8 0 0 1 9 24l5-5" /></>;
  else if (/^(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.extension)) body = <><rect x="7" y="9" width="34" height="30" rx="3" /><circle cx="18" cy="19" r="3" /><path d="m8 34 10-9 6 5 7-9 10 12" /></>;
  else body = <><path d="M12 5h16l9 9v29H12ZM28 5v10h9" /><path d={item.kind === "text" ? "M18 23h13M18 29h13M18 35h9" : "M18 25h13M18 31h9"} /></>;
  return <svg className="tray-file-glyph" data-kind={item.kind} data-extension={item.extension?.toLowerCase()} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">{body}</svg>;
}

const previewCache = new Map<string, string>();
function ItemPreview({ item }: { item: TrayItem }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const cacheKey = `${item.id}|${item.value}|${item.sizeBytes ?? ""}`;
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setWanted(true); observer.disconnect(); }
    }, { root: node.closest(".tray-rack"), rootMargin: "0px 120px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    setPreview(null);
    if (wanted && item.available && (item.kind === "file" || item.kind === "folder")) {
      const cached = previewCache.get(cacheKey);
      if (cached) { setPreview(cached); return; }
      void invoke<string | null>("tray_preview", { id: item.id }).then((data) => {
        if (!disposed) {
          if (data) {
            if (previewCache.size >= 64) previewCache.delete(previewCache.keys().next().value!);
            previewCache.set(cacheKey, data);
          }
          setPreview(data);
        }
      }).catch(() => {});
    }
    return () => { disposed = true; };
  }, [item.id, item.available, item.kind, wanted, cacheKey]);
  return <span className="tray-item-preview" ref={host}>
    {preview ? <img src={preview} alt="" draggable={false} onError={() => setPreview(null)} /> : <FileGlyph item={item} />}
  </span>;
}

export function TrayTab({ tray, onShare, sharingBusy = false }: { tray: TrayModel; onShare?: (ids: string[]) => void; sharingBusy?: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const rack = useRef<HTMLDivElement>(null);
  const press = useRef<{ id: string; x: number; y: number } | null>(null);
  const ignoreClick = useRef(false);
  const current = selected.filter((id) => tray.items.some((item) => item.id === id));
  const chosen = tray.items.filter((item) => current.includes(item.id));
  const single = chosen.length === 1 ? chosen[0] : null;
  const busy = tray.pending;
  useEffect(() => { void tray.refresh(); }, [tray.refresh]);
  useEffect(() => {
    const pasteKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        if (!event.repeat) void tray.paste();
      }
    };
    window.addEventListener("keydown", pasteKey);
    return () => window.removeEventListener("keydown", pasteKey);
  }, [tray.paste]);
  const choose = (id: string, ctrl: boolean, shift: boolean) => {
    const next = selectTrayItem(tray.items, current, id, anchor.current, ctrl, shift);
    if (!shift) anchor.current = id;
    setSelected(next);
  };
  const open = (item: TrayItem) => void (item.kind === "text"
    ? tray.perform("tray_copy", { ids: [item.id] }, "Teks disalin")
    : tray.perform("tray_open", { id: item.id }));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { setSelected([]); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(tray.items.map((item) => item.id)); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && current.length) { event.preventDefault(); void tray.perform("tray_copy", { ids: current }, "Pilihan disalin"); }
    else if (event.key === "Delete" && current.length) { event.preventDefault(); void tray.perform("tray_remove", { ids: current }, "Dikeluarkan dari Tray"); }
    else if (event.key === "Enter" && single) { event.preventDefault(); open(single); }
  };
  return <section className="notch-tray" aria-label="Tray" data-targeted={tray.targeted} aria-busy={busy}
    onKeyDown={onKeyDown}
    onPaste={(event) => { event.preventDefault(); void tray.paste(); }}
    onDragOver={(event) => { event.preventDefault(); if (!tray.dragging.current) tray.setTargeted(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) tray.setTargeted(false); }}
    onDrop={(event) => { event.preventDefault(); tray.setTargeted(false); if (tray.dragging.current) return;
      const text = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).join("\n") || event.dataTransfer.getData("text/plain");
      if (text && !event.dataTransfer.files.length) void tray.addText(text);
    }}>
    <div className="tray-shelf">
      <svg className="tray-outline" aria-hidden="true"><rect /></svg>
      <div className="tray-toolbar">
        <div className="tray-tools" data-selected={current.length > 0}>
          {current.length > 0 ? <>
            {onShare && <Tool name="share" label="Kirim file lewat LocalSend" disabled={busy || sharingBusy || chosen.some((item) => item.kind !== "file" || !item.available)} onClick={() => onShare(current)} />}
            <Tool name="open" label={single?.kind === "text" ? "Salin teks" : "Buka item"} disabled={busy || !single || !single.available} onClick={() => single && open(single)} />
            <Tool name="reveal" label="Tampilkan di Explorer" disabled={busy || !single || !single.available || !["file", "folder"].includes(single.kind)} onClick={() => single && void tray.perform("tray_reveal", { id: single.id })} />
            <Tool name="copy" label="Salin pilihan" disabled={busy || chosen.some((item) => !item.available)} onClick={() => void tray.perform("tray_copy", { ids: current }, "Pilihan disalin")} />
            <Tool name="remove" label="Keluarkan dari Tray" disabled={busy} onClick={() => void tray.perform("tray_remove", { ids: current }, "Dikeluarkan dari Tray")} />
          </> : tray.items.length > 0 && <Tool name="clear" label="Kosongkan Tray" disabled={busy} onClick={() => void tray.perform("tray_clear", undefined, "Tray dikosongkan")} />}
        </div>
      </div>
      {tray.items.length === 0 ? <div className="tray-empty" data-loading={tray.revision < 0}>
        <svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path className="tray-empty-bowl" d="M5 17h7l2 4h4l2-4h7v9H5Z" /><path d="m5 17 3-8h4M20 9h4l3 8M16 3v11M12 10l4 4 4-4" /></svg>
        <span>{tray.revision < 0 ? "Memuat Tray…" : tray.targeted ? "Lepaskan untuk menambahkan" : "Taruh file di sini"}</span>
        <small>atau tempel dengan Ctrl+V</small>
      </div> : <div className="tray-rack" ref={rack} role="group" aria-label="Item Tray" tabIndex={0}
        onWheel={(event) => { if (rack.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) rack.current.scrollLeft += event.deltaY; }}
        onClick={(event) => { if (event.target === event.currentTarget) setSelected([]); }}>
        {tray.items.map((item) => <button key={item.id} type="button" className="tray-item" data-selected={current.includes(item.id)} data-missing={!item.available}
          aria-pressed={current.includes(item.id)} title={`${item.name}\n${item.value.slice(0, 300)}`} aria-label={`${item.name}, ${trayDetail(item)}`}
          draggable={item.kind === "text" || item.kind === "link"}
          onDragStart={(event) => {
            if (item.kind !== "text" && item.kind !== "link") { event.preventDefault(); return; }
            press.current = null; ignoreClick.current = true; tray.dragging.current = true;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("text/plain", item.value);
            if (item.kind === "link") event.dataTransfer.setData("text/uri-list", item.value);
          }}
          onDragEnd={() => { tray.dragging.current = false; tray.setTargeted(false); }}
          onClick={(event) => { if (ignoreClick.current) { ignoreClick.current = false; return; } choose(item.id, event.ctrlKey || event.metaKey, event.shiftKey); }}
          onDoubleClick={() => item.available && open(item)}
          onContextMenu={(event) => { event.preventDefault(); if (!current.includes(item.id)) choose(item.id, false, false); }}
          onPointerDown={(event) => { ignoreClick.current = false; if (event.button === 0) press.current = { id: item.id, x: event.clientX, y: event.clientY }; }}
          onPointerUp={() => { press.current = null; }} onPointerCancel={() => { press.current = null; }}
          onPointerMove={(event) => {
            const start = press.current;
            if (item.kind === "text" || item.kind === "link") return;
            if (!start || !(event.buttons & 1) || busy || tray.dragging.current) return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
            press.current = null;
            const ids = current.includes(item.id) ? current : [item.id];
            setSelected(ids); ignoreClick.current = true; tray.dragging.current = true;
            void tray.perform("tray_start_drag", { ids }).finally(() => { tray.dragging.current = false; tray.setTargeted(false); });
          }}>
          <span className="tray-selection" aria-hidden="true">{current.includes(item.id) ? "✓" : ""}</span>
          <ItemPreview item={item} />
          <span className="tray-item-name">{item.name}</span>
          {!item.available && <span className="tray-item-detail">Tidak ditemukan</span>}
        </button>)}
      </div>}
      {(tray.error || tray.notice) && <div className="tray-feedback" data-error={!!tray.error} role={tray.error ? "alert" : "status"}>{tray.error || tray.notice}</div>}
    </div>
  </section>;
}
