import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runtimeConfig } from "./config";
import { INITIAL_NOTIFICATIONS } from "./notifications";
import type { NotificationSnapshot } from "./notifications";

export function useNotifications(active: boolean) {
  const [snapshot, setSnapshot] = useState(INITIAL_NOTIFICATIONS);
  const [filter, setFilter] = useState<{ mode: "all" | "selected"; appIds: string[] }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("notch-notification-filter") || "null");
      if (saved && saved.mode === "selected" && Array.isArray(saved.appIds))
        return { mode: "selected", appIds: saved.appIds.filter((id: unknown): id is string => typeof id === "string").slice(0, 100) };
    } catch { /* Invalid saved preference uses the all-apps default. */ }
    return { mode: "all", appIds: [] };
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const accept = useCallback((next: NotificationSnapshot) => {
    if (!next || !Array.isArray(next.items)) return;
    setSnapshot((before) => next.revision >= before.revision ? next : before);
  }, []);
  const perform = useCallback(async (command: string, args?: Record<string, unknown>) => {
    setPending(true); setError("");
    try { accept(await invoke<NotificationSnapshot>(command, args)); return true; }
    catch (reason) { setError(typeof reason === "string" ? reason : "Notifikasi Windows tidak dapat dibaca."); return false; }
    finally { setPending(false); }
  }, [accept]);
  useEffect(() => {
    if (!runtimeConfig.features.notifications) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<NotificationSnapshot>("notifications-state", ({ payload }) => accept(payload)).then((unlisten) => {
      if (disposed) unlisten(); else { stop = unlisten; void perform("notifications_snapshot"); }
    }).catch(() => setError("Notifikasi tidak terhubung. Jalankan ulang aplikasi."));
    return () => { disposed = true; stop?.(); };
  }, [accept, perform]);
  useEffect(() => { if (active && runtimeConfig.features.notifications) void perform("notifications_refresh"); }, [active, perform]);
  useEffect(() => { try { localStorage.setItem("notch-notification-filter", JSON.stringify(filter)); } catch { /* Storage is optional. */ } }, [filter]);
  const items = useMemo(() => filter.mode === "all" ? snapshot.items : snapshot.items.filter((item) => filter.appIds.includes(item.appId)), [snapshot.items, filter]);
  return { ...snapshot, items, allItems: snapshot.items, filter, setFilter, error, pending, perform };
}
export type NotificationModel = ReturnType<typeof useNotifications>;
