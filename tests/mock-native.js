import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { INITIAL_SHARING } from "../src/sharing.ts";
import { INITIAL_NOTIFICATIONS } from "../src/notifications.ts";
import { runtimeConfig } from "../src/config.ts";

// Browser-only fixture; never imported by the production entrypoint.
mockWindows("main");
window.__notchCommands = [];
window.__notchVolume = { level: 0.4, muted: false };
// Quick Settings reads both rows once on mount, so the fixture keeps a single
// source of truth that `brightness_set` updates just like the real panel does.
window.__notchQuickSettings = {
  brightness: 50,
  brightnessSupported: true,
  dnd: false,
  dndSupported: true,
};
window.__notchBrightnessFail = false;
// The unsupported-brightness case has to be in place before the widget mounts,
// so the fixture reads it from the page URL instead of mutating a live mount.
if (new URLSearchParams(window.location.search).get("brightness") === "unsupported") {
  window.__notchQuickSettings = { ...window.__notchQuickSettings, brightnessSupported: false };
}
mockIPC((command, args) => {
  window.__notchCommands.push({ command, args });
  if (command === "config_get") return structuredClone(window.__configMock ?? runtimeConfig);
  if (command === "config_save") { window.__savedConfig = structuredClone(args.config); return null; }
  if (command.startsWith("weather_")) return window.__weatherMock ? window.__weatherMock(command, args) : null;
  if (command.startsWith("notifications_")) {
    return window.__notificationsMock ? window.__notificationsMock(command, args) : INITIAL_NOTIFICATIONS;
  }
  if (command.startsWith("sharing_")) {
    return window.__sharingMock ? window.__sharingMock(command, args) : INITIAL_SHARING;
  }
  if (command.startsWith("tray_")) {
    if (window.__trayMock) return window.__trayMock(command, args);
    if (command === "tray_snapshot") return { items: [], revision: 0 };
  }
  // The volume panel reads the level back on mount; a mock that answered
  // nothing would leave it stuck at zero.
  if (command === "volume_get") {
    return window.__notchVolumeFail ? Promise.reject(new Error("no audio endpoint")) : window.__notchVolume;
  }
  if (command === "volume_set") {
    if (window.__notchVolumeFail) return Promise.reject(new Error("no audio endpoint"));
    window.__notchVolume = { level: args.level, muted: args.muted };
    return null;
  }
  if (command === "quicksettings_get") {
    return window.__notchQuickSettings;
  }
  if (command === "dnd_toggle") {
    window.__notchQuickSettings.dnd = !window.__notchQuickSettings.dnd;
    return window.__notchQuickSettings.dnd;
  }
  if (command === "brightness_set") {
    if (window.__notchBrightnessFail || !window.__notchQuickSettings.brightnessSupported) {
      return Promise.reject(new Error("no backlight"));
    }
    window.__notchQuickSettings = { ...window.__notchQuickSettings, brightness: args.value };
    return null;
  }
  // The system monitor widget renders percentages straight from this payload;
  // answering null used to crash the whole fixture when that widget rotated in.
  if (command === "sysinfo_stats") {
    if (window.__notchStatsFail) return Promise.reject(new Error("system stats unavailable"));
    return {
      cpuPercent: 34,
      memPercent: 58,
      memUsedGb: 9.4,
      memTotalGb: 16,
      diskPercent: 61,
      diskUsedGb: 290,
      diskTotalGb: 476,
      diskLabel: "C:",
    };
  }
  return null;
}, { shouldMockEvents: true });

// This SDK version's event API sends `eventId`, but its mock unlistener reads
// `id`. Normalize the fixture input so StrictMode cleanup removes both the
// listener and callback, instead of warning on every subsequent synthetic event.
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) =>
  invoke(command, command === "plugin:event|unlisten" ? { ...args, id: args.eventId } : args, options);
