import type { TrayItem } from "./tray";

export type SharingPeer = { id: string; alias: string; deviceModel: string; deviceType: string;
  ipAddress: string; port: number; protocol: string; fingerprint: string; lastSeenMs: number };
export type SharingTransfer = { state: "idle" | "waiting" | "sending" | "succeeded" | "failed" | "cancelled";
  peerId: string; peerName: string; currentFile: string; bytesDone: number; bytesTotal: number;
  filesDone: number; filesTotal: number; message: string };
export type SharingSnapshot = { revision: number; alias: string; fingerprint: string; serverRunning: boolean;
  discovering: boolean; diagnostic: string; peers: SharingPeer[]; transfer: SharingTransfer };
export const INITIAL_SHARING: SharingSnapshot = { revision: -1, alias: "NotchApp", fingerprint: "", serverRunning: false,
  discovering: false, diagnostic: "", peers: [], transfer: { state: "idle", peerId: "", peerName: "",
    currentFile: "", bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, message: "" } };
export const transferBusy = (transfer: SharingTransfer) => transfer.state === "waiting" || transfer.state === "sending";
/** Resolve the live Tray, never a second file queue. An empty selection stays empty. */
export function sharingTrayFiles(items: readonly TrayItem[], selectedIds: readonly string[] | null) {
  return items.filter((item) => item.kind === "file" && item.available
    && (selectedIds === null || selectedIds.includes(item.id)));
}
export function transferFraction(transfer: SharingTransfer): number {
  if (transfer.state === "succeeded") return 1;
  const value = transfer.bytesTotal > 0 ? transfer.bytesDone / transfer.bytesTotal
    : transfer.filesTotal > 0 ? transfer.filesDone / transfer.filesTotal : 0;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
export function sharingBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

