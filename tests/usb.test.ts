import { describe, expect, test } from "bun:test";
import { foldUsb, usbCapacity } from "../src/usb";
import type { UsbActivity, UsbEvent } from "../src/usb";

const event = (kind: UsbEvent["kind"], deviceId = "stick#1", capacityBytes?: number): UsbEvent =>
  ({ kind, detail: "SanDisk Cruzer Blade", usb: { deviceId, capacityBytes } });
const add = () => foldUsb<UsbActivity>([], event("usb-connected"), 1);

describe("USB attachment queue", () => {
  test("detection is reading, metadata does not restart the intro", () => {
    const queue = add();
    const ready = foldUsb(queue, event("usb-ready", "stick#1", 32e9), 2);
    expect(ready[0].id).toBe(1);
    expect(ready[0].usb).toMatchObject({ phase: "reading", ready: true, capacityBytes: 32e9 });
    expect(foldUsb(ready, event("usb-ready"), 3)).toBe(ready);
    expect(foldUsb(ready, event("usb-connected"), 4)).toBe(ready);
  });
  test("removal replaces only its own queued attachment", () => {
    const queue = foldUsb(add(), event("usb-connected", "mouse#2"), 2);
    const removed = foldUsb(queue, event("usb-disconnected"), 3);
    expect(removed).toHaveLength(2);
    expect(removed[0]).toMatchObject({ id: 3, usb: { phase: "removed", deviceId: "stick#1" } });
    expect(removed[1]).toBe(queue[1]);
    expect(foldUsb(removed, event("usb-ready"), 4)).toBe(removed);
    expect(foldUsb(removed, event("usb-disconnected"), 5)).toBe(removed);
  });
  test("stale replies cannot resurrect a notice or complete a reinserted device", () => {
    expect(foldUsb<UsbActivity>([], event("usb-ready"), 3)).toEqual([]);
    const reinserted = foldUsb<UsbActivity>([], event("usb-connected", "stick#2"), 4);
    expect(foldUsb(reinserted, event("usb-ready"), 5)).toBe(reinserted);
  });
  test("separate physical devices each have their own notice", () => {
    const queue = foldUsb(add(), event("usb-connected", "other#2"), 2);
    expect(queue).toHaveLength(2);
    expect(foldUsb(queue, event("usb-disconnected", "other#2"), 3)[0]).toBe(queue[0]);
  });

  test("metadata failure retains a known name but never invents capacity", () => {
    const queue = add();
    const reply = { ...event("usb-ready"), detail: "" };
    const result = foldUsb(queue, reply, 2);
    expect(result[0].detail).toBe("SanDisk Cruzer Blade");
    expect(result[0].usb?.capacityBytes).toBeUndefined();
  });
});

test("capacity is real decimal size; unknown values have no label", () => {
  expect(usbCapacity(32e9)).toBe("32 GB");
  expect(usbCapacity(31_268_536_320)).toBe("31.3 GB");
  expect(usbCapacity(2e12)).toBe("2 TB");
  expect(usbCapacity(512e6)).toBe("512 MB");
  for (const bytes of [null, undefined, 0, -1, NaN, Infinity]) expect(usbCapacity(bytes)).toBe("");
});
