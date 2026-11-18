import { emit } from "@tauri-apps/api/event";
import { INITIAL_SHARING } from "../src/sharing.ts";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, text) => { if (!ok) throw new Error(text); };
let state = { ...structuredClone(INITIAL_SHARING), revision: 0, alias: "Desktop Notch", serverRunning: true };
let tray = { items: [], revision: 0 };
const clipboard = ["C:\\Review\\Proposal produk.pdf", "C:\\Review\\Foto perjalanan.png"];
const peers = [{ id: "pixel", alias: "Pixel 9", deviceModel: "Android", deviceType: "mobile", ipAddress: "192.0.2.20", port: 53317, protocol: "https", fingerprint: "fixture", lastSeenMs: Date.now() },
  { id: "laptop", alias: "Laptop kerja", deviceModel: "Windows", deviceType: "desktop", ipAddress: "192.0.2.21", port: 53317, protocol: "https", fingerprint: "fixture2", lastSeenMs: Date.now() }];
async function publish() { state.revision++; await emit("sharing-state", structuredClone(state)); return structuredClone(state); }
async function publishTray() { tray.revision++; await emit("tray-state", structuredClone(tray)); return structuredClone(tray); }
window.__trayMock = async (command, args = {}) => {
  if (command === "tray_snapshot") return structuredClone(tray);
  let added = 0;
  if (command === "tray_add_paths" || command === "tray_paste") {
    const paths = command === "tray_paste" ? clipboard : args.paths;
    for (const path of paths) if (!tray.items.some((item) => item.value === path)) {
      tray.items.push({ id: path, value: path, kind: "file", name: path.split(/[\\/]/).at(-1),
        extension: path.split(".").at(-1), sizeBytes: 500, available: true, addedAtMs: Date.now() }); added++;
    }
  } else if (command === "tray_remove") tray.items = tray.items.filter((file) => !args.ids.includes(file.id));
  else if (command === "tray_clear") tray.items = [];
  else return null;
  return { snapshot: await publishTray(), added, skipped: 0 };
};
window.__sharingMock = async (command, args = {}) => {
  if (command === "sharing_snapshot" || command === "sharing_active") return structuredClone(state);
  if (window.__sharingFail) throw "Perangkat tidak dapat dihubungi. Coba cari ulang.";
  if (command === "sharing_refresh" || command === "sharing_add_peer_clipboard") state.peers = peers;
  else if (command === "sharing_cancel") state.transfer = { ...state.transfer, state: "cancelled", message: "Pengiriman dibatalkan." };
  else if (command === "sharing_send") {
    const files = tray.items.filter((file) => file.kind === "file" && file.available
      && (args.trayIds == null || args.trayIds.includes(file.id)));
    check(files.length > 0, "No sending without current Tray files");
    const peer = peers.find((item) => item.id === args.peerId);
    check(peer, "Only send to a known selected peer");
    state.transfer = { ...structuredClone(INITIAL_SHARING.transfer), state: "waiting", peerId: peer.id,
      peerName: peer.alias, bytesTotal: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      filesTotal: files.length, message: "Menunggu persetujuan penerima…" };
  } else throw `Unexpected Sharing command: ${command}`;
  return publish();
};
const calls = (name) => window.__notchCommands.filter((entry) => entry.command === name);
const tab = (id) => document.querySelector(`[role="tab"][data-tab-id="${id}"]`);
async function openSharing() {
  if (document.querySelector("[data-notch]").getAttribute("aria-expanded") !== "true") {
    await emit("notch-press", null); await wait(800);
  }
  tab("sharing").click(); await wait(500);
}
window.runSharingScenario = async (scenario = "empty") => {
  await openSharing();
  switch (scenario) {
    case "empty":
      check(document.querySelector(".sharing-source")?.textContent.includes("Belum ada file di Tray"), "empty source points to Tray");
      check(!document.querySelector(".sharing-files"), "Sharing has no file drop area or second file list");
      check(document.querySelector(".sharing-peer-empty")?.textContent.includes("Belum ada perangkat"), "empty peers are honest");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
      await wait(100);
      check(!calls("sharing_paste").length && !calls("tray_paste").length, "Sharing does not handle file pasting");
      break;
    case "stage": {
      const before = calls("sharing_send").length;
      document.querySelector(".sharing-source button:last-child").click(); await wait(500);
      check(tab("tray").getAttribute("aria-selected") === "true", "Buka Tray opens the file holder");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
      await wait(120);
      check(document.querySelectorAll(".tray-item").length === 2, "Ctrl+V stages files in Tray");
      await openSharing();
      document.querySelector('[aria-label="Cari perangkat"]').click(); await wait(120);
      check(document.querySelector(".sharing-source").textContent.includes("2 file dari Tray"), "Sharing derives files from Tray");
      check(document.querySelectorAll(".sharing-peer").length === 2, "discovered peers appear");
      check(calls("sharing_send").length === before, "paste/discovery never send automatically");
      break;
    }
    case "transfer":
      document.querySelector('[aria-label="Kirim ke Pixel 9"]').click(); await wait(100);
      check(document.querySelector(".sharing-transfer").dataset.state === "waiting", "sender waits for recipient approval");
      check(calls("sharing_send").at(-1).args.trayIds === null, "default send resolves all Tray files natively");
      state.transfer = { ...state.transfer, state: "sending", currentFile: "Proposal produk.pdf", bytesDone: 400 };
      await publish(); await wait(100);
      check(document.querySelector('[role="progressbar"]').getAttribute("aria-valuenow") === "40", "progress uses actual bytes");
      document.querySelector(".sharing-transfer-footer button").click(); await wait(100);
      check(state.transfer.state === "cancelled", "cancel reaches native command");
      check(tray.items.length === 2, "cancellation keeps files in Tray");
      break;
    case "success":
      document.querySelector('[aria-label="Kirim ke Pixel 9"]').click(); await wait(100);
      state.transfer = { ...state.transfer, state: "succeeded", bytesDone: 1000, filesDone: 2, message: "Terkirim ke Pixel 9." };
      await publish(); await wait(100);
      check(document.querySelector('.sharing-result[data-state="succeeded"]')?.textContent.includes("Terkirim"), "confirmed success is visible");
      check(tray.items.length === 2, "sending keeps Tray intact");
      break;
    case "drop": {
      const rect = document.querySelector(".notch-sharing").getBoundingClientRect();
      const paths = ["C:\\Review\\Drop.docx"];
      const position = { x: (rect.left + 30) * devicePixelRatio, y: (rect.top + 40) * devicePixelRatio };
      await emit("tauri://drag-drop", { paths, position }); await wait(600);
      check(tray.items.some((file) => file.name === "Drop.docx"), "drop goes to Tray even from Sharing");
      check(tab("tray").getAttribute("aria-selected") === "true", "drop opens Tray");
      await openSharing();
      check(document.querySelector(".sharing-source").textContent.includes("3 file dari Tray"), "dropped file is available without importing again");
      break;
    }
    case "selection": {
      tab("tray").click(); await wait(500);
      document.querySelector(".tray-item").click(); await wait(100);
      document.querySelector('[aria-label="Kirim file lewat LocalSend"]').click(); await wait(500);
      check(document.querySelector(".sharing-source").textContent.includes("1 file dipilih dari Tray"), "Tray selection is retained in Sharing");
      document.querySelector('[aria-label="Kirim ke Pixel 9"]').click(); await wait(100);
      check(calls("sharing_send").at(-1).args.trayIds.length === 1 && state.transfer.filesTotal === 1, "selected send does not include other files");
      document.querySelector(".sharing-transfer-footer button").click(); await wait(100);
      const selectedId = calls("sharing_send").at(-1).args.trayIds[0];
      await window.__trayMock("tray_remove", { ids: [selectedId] }); await wait(100);
      check(document.querySelector('[aria-label="Kirim ke Pixel 9"]').disabled, "removed selection cannot silently send remaining files");
      document.querySelector(".sharing-source button").click(); await wait(100);
      check(document.querySelector(".sharing-source").textContent.includes("2 file dari Tray"), "all-files mode uses current Tray");
      break;
    }
    case "persist":
      tab("nook").click(); await wait(500); await openSharing();
      check(document.querySelector(".sharing-source").textContent.includes(`${tray.items.length} file dari Tray`), "Tray source survives tab remount");
      await window.__trayMock("tray_clear"); await wait(100);
      check(document.querySelector('[aria-label="Kirim ke Pixel 9"]').disabled, "cleared Tray immediately disables sending");
      break;
    case "error":
      window.__sharingFail = true;
      document.querySelector('[aria-label="Cari perangkat"]').click(); await wait(100);
      check(document.querySelector('.sharing-notice[role="alert"]')?.textContent.includes("tidak dapat dihubungi"), "network error remains readable");
      window.__sharingFail = false;
      break;
  }
  const bounds = document.querySelector(".notch-sharing").getBoundingClientRect();
  check(bounds.width <= 641 && bounds.height === 148, "sharing fits fixed notch surface");
  return { scenario, ok: true, trayFiles: tray.items.length, peers: state.peers.length };
};
