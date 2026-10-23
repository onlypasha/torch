/** USB events carry an attachment identity shared by detection, metadata and removal. */
export type UsbKind = "usb-connected" | "usb-ready" | "usb-disconnected";
export type UsbPhase = "reading" | "ready" | "removed";
export type UsbPayload = { deviceId: string; capacityBytes?: number | null };
export type UsbState = UsbPayload & { phase: UsbPhase; ready: boolean };
export type UsbActivity = {
  id: number;
  kind: "usb-connected" | "usb-disconnected";
  detail: string;
  usb: UsbState;
};
export type UsbEvent = { kind: UsbKind; detail: string; usb: UsbPayload };

export const USB_READING_MS = 800;
export const USB_READY_MS = 2600;
export const USB_REMOVED_MS = 1800;
export const USB_TIMEOUT_MS = 12000;

export const isUsbKind = (kind: string): kind is UsbKind =>
  kind === "usb-connected" || kind === "usb-ready" || kind === "usb-disconnected";

/** Decimal capacity of the physical disk, never partition size or free space. */
export function usbCapacity(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const unit = bytes >= 1e12 ? "TB" : bytes >= 1e9 ? "GB" : "MB";
  const value = bytes / (unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : 1e6);
  return `${Number(value.toFixed(1))} ${unit}`;
}

/**
 * A metadata reply updates an existing attachment, never resurrects a removed
 * one. Removal replaces that attachment in place (including one still queued),
 * with a fresh animation key; unrelated devices retain their order.
 */
export function foldUsb<T extends { id: number; kind: string; detail: string; usb?: UsbState }>(
  queue: T[],
  event: UsbEvent,
  nextId: number,
): (T | UsbActivity)[] {
  const at = queue.findIndex((item) => item.usb?.deviceId === event.usb.deviceId);
  const before = queue[at];
  if (event.kind === "usb-ready") {
    if (before?.usb?.phase !== "reading" || before.usb.ready) return queue;
    return queue.map((item, index) => index === at ? {
      ...item,
      // A failed metadata query must not erase a product name detection knew.
      detail: event.detail.trim() ? event.detail : item.detail,
      usb: { ...before.usb!, ready: true, capacityBytes: event.usb.capacityBytes },
    } : item);
  }
  if (before !== undefined &&
      (event.kind === "usb-connected" || before.usb?.phase === "removed")) return queue;
  const removed = event.kind === "usb-disconnected";
  const item: UsbActivity = {
    id: nextId, kind: event.kind, detail: event.detail,
    usb: { ...event.usb, phase: removed ? "removed" : "reading", ready: false },
  };
  return at === -1 ? [...queue, item] : queue.map((old, index) => index === at ? item : old);
}
