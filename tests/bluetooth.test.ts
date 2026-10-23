import { expect, test } from "bun:test";
import { batteryLevel, foldBluetooth } from "../src/bluetooth";
import type { BluetoothActivity, BluetoothEvent } from "../src/bluetooth";

const event = (kind: BluetoothEvent["kind"], deviceId = "headset#1", batteryPercent?: number): BluetoothEvent =>
  ({ kind, detail: "AirPods Pro", bluetooth: { deviceId, batteryPercent } });
const add = () => foldBluetooth<BluetoothActivity>([], event("bluetooth-connected"), 1);

test("battery metadata preserves phase/key; repeats are idempotent", () => {
  const ready = foldBluetooth(add(), event("bluetooth-updated", "headset#1", 85), 2);
  expect(ready[0]).toMatchObject({ id: 1, bluetooth: { phase: "connecting", batteryPercent: 85 } });
  expect(foldBluetooth(ready, event("bluetooth-connected"), 3)).toBe(ready);
  expect(foldBluetooth(ready, event("bluetooth-updated", "headset#1", 85), 4)).toBe(ready);
});

test("two equal names represent two different devices", () => {
  const queue = foldBluetooth(add(), event("bluetooth-connected", "headset#2"), 2);
  expect(queue).toHaveLength(2);
  const cancelled = foldBluetooth(queue, event("bluetooth-disconnected", "headset#2"), 3);
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toBe(queue[0]);
});

test("head cancellation is silent and rejects late metadata", () => {
  const cancelled = foldBluetooth(add(), event("bluetooth-disconnected"), 2);
  expect(cancelled[0].bluetooth?.phase).toBe("cancelled");
  expect(foldBluetooth(cancelled, event("bluetooth-updated", "headset#1", 85), 3)).toBe(cancelled);
  expect(foldBluetooth(cancelled, event("bluetooth-disconnected"), 4)).toBe(cancelled);
});

test("idle disconnect/metadata produce no notice; reconnection uses a fresh identity", () => {
  const empty: BluetoothActivity[] = [];
  expect(foldBluetooth(empty, event("bluetooth-disconnected"), 1)).toBe(empty);
  expect(foldBluetooth(empty, event("bluetooth-updated"), 2)).toBe(empty);
  const queue = foldBluetooth(empty, event("bluetooth-connected", "headset#2"), 3);
  expect(foldBluetooth(queue, event("bluetooth-disconnected"), 4)).toBe(queue);
  expect(foldBluetooth(queue, event("bluetooth-updated"), 5)).toBe(queue);
});

test("battery accepts real zero but hides unknown, invalid and fractional values", () => {
  expect(batteryLevel(0)).toBe(0);
  expect(batteryLevel(85)).toBe(85);
  expect(batteryLevel(100)).toBe(100);
  for (const level of [undefined, null, -1, 101, 255, NaN, Infinity, 0.85]) expect(batteryLevel(level)).toBeUndefined();
});
