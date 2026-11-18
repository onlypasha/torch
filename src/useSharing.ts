import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { runtimeConfig } from "./config";
import { INITIAL_SHARING, transferBusy } from "./sharing";
import type { SharingSnapshot } from "./sharing";

export function useSharing(active: boolean) {
  const [snapshot, setSnapshot] = useState(INITIAL_SHARING);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const [selectedTrayIds, selectTrayFiles] = useState<string[] | null>(null);
  const accept = useCallback((next: SharingSnapshot) => {
    if (!next || !Array.isArray(next.peers)) return;
    setSnapshot((previous) => next.revision >= previous.revision ? next : previous);
  }, []);
  const perform = useCallback(async (command: string, args?: Record<string, unknown>) => {
    setPending((n) => n + 1); setError("");
    try { accept(await invoke<SharingSnapshot>(command, args)); return true; }
    catch (reason) { setError(typeof reason === "string" ? reason : "Sharing tidak dapat diproses. Coba lagi."); return false; }
    finally { setPending((n) => n - 1); }
  }, [accept]);
  useEffect(() => {
    if (!runtimeConfig.features.sharing) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<SharingSnapshot>("sharing-state", ({ payload }) => accept(payload)).then((unlisten) => {
      if (disposed) unlisten(); else { stop = unlisten; void perform("sharing_snapshot"); }
    }).catch(() => setError("Sharing tidak terhubung. Jalankan ulang aplikasi."));
    return () => { disposed = true; stop?.(); };
  }, [accept, perform]);
  useEffect(() => {
    if (!runtimeConfig.features.sharing) return;
    void perform("sharing_active", { active });
    return () => { void invoke("sharing_active", { active: false }).catch(() => {}); };
  }, [active, perform]);
  return { ...snapshot, error, pending: pending > 0, busy: transferBusy(snapshot.transfer),
    selectedTrayIds, selectTrayFiles, perform };
}
export type SharingModel = ReturnType<typeof useSharing>;
