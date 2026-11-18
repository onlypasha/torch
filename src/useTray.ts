import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runtimeConfig } from "./config";
import type { TrayMutation, TraySnapshot } from "./tray";

export function useTray(active: boolean) {
  const [snapshot, setSnapshot] = useState<TraySnapshot>({ items: [], revision: -1 });
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [targeted, setTargeted] = useState(false);
  const [dropPulse, setDropPulse] = useState(0);
  const dragging = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pasting = useRef(false);
  useEffect(() => {
    if (!runtimeConfig.features.tray) return;
    void invoke("tray_set_active", { active }).catch(() => {});
    return () => { void invoke("tray_set_active", { active: false }).catch(() => {}); };
  }, [active]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const accept = useCallback((next: TraySnapshot) => {
    if (!next || !Array.isArray(next.items)) return;
    setSnapshot((previous) => next.revision >= previous.revision ? next : previous);
  }, []);
  const refresh = useCallback(async () => {
    try { accept(await invoke<TraySnapshot>("tray_snapshot")); }
    catch { setError("Tray tidak dapat dibaca. Coba buka tab ini lagi."); }
  }, [accept]);
  useEffect(() => {
    if (!runtimeConfig.features.tray) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<TraySnapshot>("tray-state", ({ payload }) => accept(payload)).then((unlisten) => {
      if (disposed) unlisten(); else { stop = unlisten; void refresh(); }
    }).catch(() => setError("Tray tidak dapat terhubung. Jalankan ulang aplikasi."));
    return () => { disposed = true; stop?.(); };
  }, [accept, refresh]);
  const perform = useCallback(async (command: string, args?: Record<string, unknown>, success = "") => {
    setPending((n) => n + 1);
    setError("");
    setNotice("");
    try {
      const result = await invoke<TrayMutation | TraySnapshot | null>(command, args);
      if (result && "snapshot" in result) {
        accept(result.snapshot);
        if (command === "tray_add_paths" && result.added > 0) setDropPulse((pulse) => pulse + 1);
        setNotice(result.added > 0 ? `${result.added} item ditambahkan${result.skipped ? `, ${result.skipped} dilewati` : ""}`
          : result.skipped > 0 ? "Item sudah ada, tidak tersedia, atau Tray penuh" : success);
      } else {
        if (result && "items" in result) accept(result);
        setNotice(success);
      }
      return true;
    } catch (reason) {
      setError(typeof reason === "string" ? reason : "Tindakan gagal. Coba lagi.");
      return false;
    } finally { setPending((n) => n - 1); }
  }, [accept]);
  const paste = useCallback(async () => {
    if (!activeRef.current || pasting.current) return;
    pasting.current = true;
    try { await perform("tray_paste"); } finally { pasting.current = false; }
  }, [perform]);
  useEffect(() => {
    if (!runtimeConfig.features.tray) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("tray-paste-request", () => { void paste(); }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, [paste]);
  const addPaths = useCallback((paths: string[]) => perform("tray_add_paths", { paths }), [perform]);
  const addText = useCallback((text: string) => perform("tray_add_text", { text }), [perform]);
  return { ...snapshot, pending: pending > 0, notice, error, targeted, setTargeted, dragging, paste, dropPulse,
    refresh, perform, addPaths, addText };
}
export type TrayModel = ReturnType<typeof useTray>;
