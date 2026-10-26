import { expect, test } from "bun:test";
import { hudAnnouncement, hudPercent, volumeWaves } from "../src/hud";

test("mute empties the bar and the number without forgetting the level", () => {
  expect(hudPercent("volume", 0.42, true)).toBe(0);
  expect(hudPercent("volume", 0.42, false)).toBe(42);
  expect(hudPercent("volume", 0.0625, false)).toBe(6);
  expect(hudPercent("volume", 0.125, false)).toBe(13);
});

test("the announcement names the state, not an optimistic level", () => {
  expect(hudAnnouncement("volume", 0.42, false)).toBe("Volume 42%");
  expect(hudAnnouncement("volume", 0.42, true)).toBe("Volume dimatikan");
  expect(hudAnnouncement("brightness", 88, false)).toBe("Kecerahan 88%");
});

test("brightness is already 0-100 and is clamped", () => {
  expect(hudPercent("brightness", 88, false)).toBe(88);
  expect(hudPercent("brightness", -4, false)).toBe(0);
  expect(hudPercent("brightness", 140, false)).toBe(100);
  expect(hudPercent("brightness", Number.NaN, false)).toBe(0);
});

test("the three volume waves follow the thirds of the range", () => {
  expect(volumeWaves(0, false)).toBe(0);
  expect(volumeWaves(0.01, false)).toBe(1);
  expect(volumeWaves(0.34, false)).toBe(1);
  expect(volumeWaves(0.35, false)).toBe(2);
  expect(volumeWaves(0.67, false)).toBe(2);
  expect(volumeWaves(0.68, false)).toBe(3);
  expect(volumeWaves(0.9, true)).toBe(0);
});
