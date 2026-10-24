import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

// Browser-only fixture; never imported by the production entrypoint.
mockWindows("main");
window.__notchCommands = [];
window.__notchVolume = { level: 0.4, muted: false };
mockIPC((command, args) => {
  window.__notchCommands.push({ command, args });
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
  return null;
}, { shouldMockEvents: true });

// This SDK version's event API sends `eventId`, but its mock unlistener reads
// `id`. Normalize the fixture input so StrictMode cleanup removes both the
// listener and callback, instead of warning on every subsequent synthetic event.
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) =>
  invoke(command, command === "plugin:event|unlisten" ? { ...args, id: args.eventId } : args, options);
