import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

// Browser-only fixture; never imported by the production entrypoint.
mockWindows("main");
window.__notchCommands = [];
mockIPC((command, args) => {
  window.__notchCommands.push({ command, args });
}, { shouldMockEvents: true });

// This SDK version's event API sends `eventId`, but its mock unlistener reads
// `id`. Normalize the fixture input so StrictMode cleanup removes both the
// listener and callback, instead of warning on every subsequent synthetic event.
const invoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = (command, args, options) =>
  invoke(command, command === "plugin:event|unlisten" ? { ...args, id: args.eventId } : args, options);
