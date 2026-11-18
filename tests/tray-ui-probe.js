import { emit } from "@tauri-apps/api/event";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
let state = { items: [], revision: 0 };
let nextId = 0;
const file = (name, kind = "file") => ({ id: String(++nextId), kind, name, value: `C:\\Documents\\${name}`,
  extension: name.split(".").at(-1), sizeBytes: 284672, available: true, addedAtMs: Date.now() });
const examples = [file("Proposal produk 2026.pdf"), file("Foto perjalanan.png"), file("Catatan rapat.txt"),
  { ...file("Dokumen proyek", "folder"), extension: "", sizeBytes: null },
  { ...file("music.youtube.com", "link"), value: "https://music.youtube.com/", extension: "" },
  { ...file("Referensi desain notch", "text"), value: "Referensi desain notch\nSimpan konteks untuk dibaca nanti", extension: "" }];
window.__trayMock = async (command, args = {}) => {
  if (command === "tray_snapshot") return structuredClone(state);
  if (window.__trayFail) throw "File tidak tersedia. Coba pilih file lain.";
  let added = 0, skipped = 0;
  if (["tray_pick_files", "tray_add_paths", "tray_paste", "tray_add_text"].includes(command)) {
    const incoming = command === "tray_add_paths" ? args.paths.map((path) => ({ ...file(path.split(/[\\/]/).at(-1)), value: path }))
      : command === "tray_add_text" ? [{ ...file(args.text.split("\n")[0], "text"), value: args.text }]
      : command === "tray_paste" ? (window.__trayClipboard ?? [examples[5]]) : examples;
    for (const item of incoming) {
      if (state.items.some((old) => old.value === item.value)) skipped++;
      else { state.items.push(item); added++; }
    }
  } else if (command === "tray_remove") state.items = state.items.filter((item) => !args.ids.includes(item.id));
  else if (command === "tray_clear") state.items = [];
  else return null;
  state.revision++;
  const snapshot = structuredClone(state);
  await emit("tray-state", snapshot);
  return { snapshot, added, skipped };
};
const trayTab = () => document.querySelector('[role="tab"][data-tab-id="tray"]');
const items = () => [...document.querySelectorAll(".tray-item")];
window.runTrayScenario = async (scenario = "empty") => {
  if (scenario === "auto-open") {
    await emit("notch-click-outside", null); await wait(700);
    check(document.querySelector("[data-notch]").getAttribute("aria-expanded") === "false", "start collapsed");
    await emit("tray-drag-hover", true); await wait(650);
    check(document.querySelector("[data-notch]").getAttribute("aria-expanded") === "true", "validated file hover opens notch");
    check(trayTab().getAttribute("aria-selected") === "true", "validated file hover selects Tray");
    check(document.querySelector(".notch-tray").dataset.targeted === "true", "drop target highlights");
    await emit("tray-native-drop", ["C:\\Drop\\Automatic.pdf"]); await wait(180);
    check(state.items.some((item) => item.name === "Automatic.pdf"), "landing-surface drop reaches retained model");
    await emit("tray-drag-hover", false); await wait(60);
    check(document.querySelector("[data-notch]").getAttribute("aria-expanded") === "true", "completed drop leaves Tray open");
    return { scenario, ok: true, count: items().length };
  }
  if (document.querySelector("[data-notch]").getAttribute("aria-expanded") !== "true") {
    await emit("notch-press", null); await wait(850);
  }
  trayTab().click(); await wait(500);
  if (scenario === "ripple") {
    const path = `C:\\Drop\\Ripple-${Date.now()}.pdf`;
    const seen = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.notch-tray-wave[data-kind="drop"]')) {
          seen.push({ noInput: getComputedStyle(node.parentElement).pointerEvents === "none",
            inNotch: !!node.closest(".notch-body") });
        }
      }
    });
    observer.observe(document.querySelector(".notch-tray-ripple"), { childList: true });
    await emit("tray-drag-hover", true); await wait(50);
    check(!!document.querySelector('.notch-tray-wave[data-kind="hover"]'), "hover renders a subtle wave");
    await emit("tray-drag-hover", false);
    await emit("tray-native-drop", [path]); await wait(100);
    check(seen.length === 1, `successful file import renders one drop ripple, got ${seen.length}`);
    check(seen[0].noInput, "ripple cannot intercept input");
    check(seen[0].inNotch, "ripple follows notch silhouette");
    await wait(850);
    check(!document.querySelector('.notch-tray-wave[data-kind="drop"]'), "completed ripple is removed");
    await emit("tray-native-drop", [path]); await wait(50);
    check(!document.querySelector('.notch-tray-wave[data-kind="drop"]'), "duplicate import does not report a successful addition");
    window.__trayFail = true;
    await emit("tray-native-drop", ["C:\\Drop\\FailedRipple.pdf"]); await wait(50);
    check(!document.querySelector('.notch-tray-wave[data-kind="drop"]'), "failed import does not play success ripple");
    window.__trayFail = false;
    observer.disconnect();
  } else if (scenario === "empty") {
    check(!document.querySelector(".tray-source, .tray-add, .tray-paste"), "Tray has no picker or paste buttons");
    check(document.querySelector(".tray-empty")?.textContent.includes("Taruh file"), "empty state directs to drop");
    check(items().length === 0, "no invented sample files");
  } else if (scenario === "filled") {
    window.__trayClipboard = examples;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })); await wait(200);
    check(items().length === 6, "Ctrl+V populates shelf from native clipboard");
    items()[0].click();
    items()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); await wait(60);
    check(document.querySelectorAll('.tray-item[data-selected="true"]').length === 3, "shift selects a range");
    document.querySelector('[aria-label="Salin pilihan"]').click(); await wait(60);
    check(window.__notchCommands.some((entry) => entry.command === "tray_copy" && entry.args.ids.length === 3), "copy sends the full selection");
  } else if (scenario === "persist") {
    document.querySelector('[role="tab"][data-tab-id="nook"]').click(); await wait(500);
    trayTab().click(); await wait(500);
    check(items().length === state.items.length && items().length > 0, "tab remount retains shelf");
  } else if (scenario === "remove") {
    items()[0].click(); await wait(30);
    const before = state.items.length;
    document.querySelector('[aria-label="Keluarkan dari Tray"]').click(); await wait(100);
    check(items().length === before - 1, "remove updates shelf");
  } else if (scenario === "drop") {
    const rect = document.querySelector(".notch-tray").getBoundingClientRect();
    const position = { x: (rect.left + 30) * devicePixelRatio, y: (rect.top + 40) * devicePixelRatio };
    await emit("tauri://drag-enter", { paths: ["C:\\Drop\\Review.docx"], position }); await wait(100);
    check(document.querySelector(".notch-tray").dataset.targeted === "true", "native drag highlights tray");
    await emit("tauri://drag-drop", { paths: ["C:\\Drop\\Review.docx"], position }); await wait(200);
    check(state.items.some((item) => item.name === "Review.docx"), "native file drop adds file");
    const count = state.items.length;
    await emit("tauri://drag-drop", { paths: ["C:\\Drop\\Review.docx"], position }); await wait(100);
    check(state.items.length === count, "duplicate drop is ignored");
  } else if (scenario === "error") {
    window.__trayFail = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })); await wait(100);
    check(document.querySelector('[role="alert"]')?.textContent.includes("File tidak tersedia"), "errors are visible");
    window.__trayFail = false;
  } else if (scenario === "paste-scope") {
    const calls = () => window.__notchCommands.filter((entry) => entry.command === "tray_paste").length;
    const before = calls();
    await emit("tray-paste-request", null); await wait(100);
    check(calls() === before + 1, "native Ctrl+V routes to clipboard import");
    document.querySelector('[role="tab"][data-tab-id="nook"]').click(); await wait(500);
    await emit("tray-paste-request", null); await wait(100);
    check(calls() === before + 1, "native paste is ignored outside Tray");
    trayTab().click(); await wait(500);
  }
  const section = document.querySelector(".notch-tray").getBoundingClientRect();
  check(section.height <= 149 && section.width <= 641, "tray fits reserved notch surface");
  return { scenario, ok: true, count: items().length };
};
