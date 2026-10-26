import { expect, test } from "bun:test";
import { brightnessLabel, volumeCommand, volumeLabel, volumePercent } from "../src/quicksettings";

// ---------------------------------------------------------------------------
// Volume: one slider, two facts
// ---------------------------------------------------------------------------

test("reaching zero mutes, and any level above it unmutes", () => {
  expect(volumeCommand(0)).toEqual({ level: 0, muted: true });
  expect(volumeCommand(0.4)).toEqual({ level: 0.4, muted: false });
  expect(volumeCommand(1)).toEqual({ level: 1, muted: false });
});

test("a level outside the scalar range is clamped, and NaN becomes silence", () => {
  expect(volumeCommand(-0.5)).toEqual({ level: 0, muted: true });
  expect(volumeCommand(1.7)).toEqual({ level: 1, muted: false });
  expect(volumeCommand(Number.NaN)).toEqual({ level: 0, muted: true });
  expect(volumeCommand(Number.POSITIVE_INFINITY)).toEqual({ level: 0, muted: true });
});

test("a muted endpoint still shows the level behind the mute", () => {
  // This is what lets the thumb be dragged up again: pinning it at zero hid
  // the level the endpoint would resume at.
  expect(volumePercent(0.42)).toBe(42);
  expect(volumeLabel(0.42, true)).toBe("Mute");
  expect(volumeLabel(0.42, false)).toBe("42%");
  expect(volumeLabel(0, false)).toBe("0%");
  expect(volumePercent(Number.NaN)).toBe(0);
});

// ---------------------------------------------------------------------------
// Brightness: only what the display can answer
// ---------------------------------------------------------------------------

test("brightness has no number to show when the display cannot report one", () => {
  expect(brightnessLabel(30, true)).toBe("30%");
  expect(brightnessLabel(30.4, true)).toBe("30%");
  expect(brightnessLabel(30, false)).toBe("—");
});
