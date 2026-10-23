export type BluetoothKind = "bluetooth-connected" | "bluetooth-updated" | "bluetooth-disconnected";
export type BluetoothPayload = { deviceId: string; batteryPercent?: number | null };
export type BluetoothPhase = "connecting" | "connected" | "cancelled";
export type BluetoothState = BluetoothPayload & { phase: BluetoothPhase };
export type BluetoothEvent = { kind: BluetoothKind; detail: string; bluetooth: BluetoothPayload };
export type BluetoothActivity = {
  id: number;
  kind: "bluetooth-connected";
  detail: string;
  bluetooth: BluetoothState;
};

export const BT_CONNECTING_MS = 1300;
export const BT_CONNECTED_MS = 2600;
export const isBluetoothKind = (kind: string): kind is BluetoothKind =>
  kind === "bluetooth-connected" || kind === "bluetooth-updated" || kind === "bluetooth-disconnected";

export function batteryLevel(value?: number | null): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value : undefined;
}

/** A silent cancellation at the head lets App collapse before the next item. */
export function foldBluetooth<T extends { id: number; kind: string; detail: string; bluetooth?: BluetoothState }>(
  queue: T[], event: BluetoothEvent, nextId: number,
): (T | BluetoothActivity)[] {
  const at = queue.findIndex((item) => item.bluetooth?.deviceId === event.bluetooth.deviceId);
  const before = queue[at];
  if (event.kind === "bluetooth-disconnected") {
    if (!before?.bluetooth || before.bluetooth.phase === "cancelled") return queue;
    return at === 0
      ? queue.map((item, i) => i === at ? { ...item, bluetooth: { ...before.bluetooth!, phase: "cancelled" as const } } : item)
      : queue.filter((_, i) => i !== at);
  }
  const level = batteryLevel(event.bluetooth.batteryPercent);
  if (before?.bluetooth) {
    if (before.bluetooth.phase === "cancelled" || event.kind === "bluetooth-connected") return queue;
    const name = event.detail.trim() ? event.detail : before.detail;
    if (before.detail === name && before.bluetooth.batteryPercent === level) return queue;
    return queue.map((item, i) => i === at ? {
      ...item, detail: name, bluetooth: { ...before.bluetooth!, batteryPercent: level },
    } : item);
  }
  // Replies for a baseline device or an already completed/cancelled notice must
  // not bring an indicator back. Only a new connection can append an activity.
  if (event.kind !== "bluetooth-connected") return queue;
  return [...queue, {
    id: nextId, kind: "bluetooth-connected", detail: event.detail,
    bluetooth: { deviceId: event.bluetooth.deviceId, batteryPercent: level, phase: "connecting" },
  }];
}
