import { emit } from "@tauri-apps/api/event";
import { INITIAL_NOTIFICATIONS } from "../src/notifications.ts";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, message) => { if (!ok) throw new Error(message); };
const now = Date.now();
let state = { ...structuredClone(INITIAL_NOTIFICATIONS), revision: 0 };
const items = [
  { id: 21, appId: "review.mail", appName: "Mail", title: "Rapat desain besok", body: "Dokumen revisi sudah siap untuk ditinjau.", createdAtMs: now, icon: null },
  { id: 22, appId: "review.calendar", appName: "Kalender", title: "Pertemuan tim", body: "Mulai pukul 14.00 di ruang utama.", createdAtMs: now - 300000, icon: null },
];
async function publish() { state.revision++; await emit("notifications-state", structuredClone(state)); return structuredClone(state); }
window.__notificationsMock = async (command, args = {}) => {
  if (command === "notifications_snapshot" || command === "notifications_refresh") return structuredClone(state);
  if (command === "notifications_request_access") { state.access = "allowed"; state.message = ""; return publish(); }
  if (command === "notifications_dismiss") { state.items = state.items.filter((item) => item.id !== args.id); return publish(); }
  if (command === "notifications_clear") { state.items = state.items.filter((item) => !args.ids.includes(item.id)); return publish(); }
  if (command === "notifications_open" || command === "notifications_settings") return null;
  throw new Error(`Unexpected command ${command}`);
};
const tab = () => document.querySelector('[role="tab"][data-tab-id="notification"]');
async function openTab() {
  if (document.querySelector("[data-notch]").getAttribute("aria-expanded") !== "true") {
    await emit("notch-press", null); await wait(800);
  }
  for (let index = 0; index < 6 && document.querySelector(".notification-interruption-dismiss"); index++) {
    document.querySelector(".notification-interruption-dismiss").click(); await wait(80);
  }
  tab().click(); await wait(500);
}
window.runNotificationScenario = async (scenario) => {
  if (scenario !== "queue") await openTab();
  if (scenario === "permission") {
    check(document.querySelector(".notification-empty")?.textContent.includes("Aktifkan notifikasi Windows"), "permission prompt visible");
    document.querySelector(".notification-empty button").click(); await wait(100);
    check(document.querySelector(".notification-empty")?.textContent.includes("Tidak ada notifikasi aktif"), "allowed but empty is distinct");
  } else if (scenario === "arrival") {
    state.items = structuredClone(items); await publish(); await wait(120);
    check(document.querySelector(".notification-interruption"), "new arrival takes over the open notch");
    check(document.querySelector(".notification-next")?.textContent === "+1", "queued count shown beside the focused notification");
    check(document.querySelector(".notification-interruption")?.textContent.includes("Pertemuan tim"), "oldest arrival remains active while open");
  } else if (scenario === "interruption-fit") {
    state.items = [{ ...items[0], id: 40, title: "You may have new messages", body: "" }];
    await publish(); await wait(700);
    const shell = document.querySelector("[data-notch]").getBoundingClientRect();
    const card = document.querySelector(".notification-interruption .notification-live").getBoundingClientRect();
    for (const inset of [card.left - shell.left, shell.right - card.right, card.top - shell.top, shell.bottom - card.bottom]) {
      check(Math.abs(inset - 12) < 1, `expanded notification leaves only 12px padding, got ${inset}`);
    }
    check(card.width === 520 && card.height === 132, "existing notification card size is preserved");
    const hit = window.__notchCommands.filter(({ command }) => command === "set_notch_hit").at(-1)?.args;
    check(hit?.width === 544 && hit?.height === 156 && hit?.clickThrough === false, "native hit area matches the fitted expanded notification");
    document.querySelector(".notification-interruption-dismiss").click(); await wait(700);
    const restored = document.querySelector("[data-notch]").getBoundingClientRect();
    const restoredHit = window.__notchCommands.filter(({ command }) => command === "set_notch_hit").at(-1)?.args;
    check(restored.width === 640 && restored.height === 200 && restoredHit?.width === 640 && restoredHit?.height === 200, "dismiss restores the underlying tab and its native geometry");
  } else if (scenario === "whatsapp") {
    state.items = [{ id: 31, appId: "WhatsApp.WhatsApp", appName: "WhatsApp", title: "Tim Produk", body: "Budi: Revisi desain sudah siap untuk ditinjau.", createdAtMs: now, icon: null }];
    await publish(); await wait(120);
    check(document.querySelector(".notification-avatar-initials")?.textContent === "TP", "WhatsApp shows initials from the conversation title");
    check(document.querySelector(".notification-avatar-badge"), "WhatsApp badge identifies the source app");
  } else if (scenario === "photo") {
    const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
    state.items = [{ id: 35, appId: "WhatsApp.WhatsApp", appName: "WhatsApp", title: "Tim Produk", body: "Pesan contoh", createdAtMs: now + 1, icon: null, avatar: null }];
    await publish(); await wait(120);
    check(document.querySelector(".notification-interruption .notification-avatar-initials")?.textContent === "TP", "new toast begins with initials");
    state.items[0].avatar = photo; await publish(); await wait(120);
    check(document.querySelector(".notification-interruption .notification-avatar-photo")?.getAttribute("src") === photo, "late photo updates the active interruption");
    await emit("notch-click-outside", null); await wait(650);
    check(document.querySelector(".notch-notification-signal .notification-avatar-photo"), "collapsed preview keeps the photo");
    state.items[0].avatar = "data:image/png;base64,invalid"; await publish(); await wait(160);
    check(document.querySelector(".notch-notification-signal .notification-avatar-initials")?.textContent === "TP", "failed photo falls back to initials");
  } else if (scenario === "collapsed-preview") {
    await emit("notch-click-outside", null); await wait(650);
    state.items = [{ id: 32, appId: "WhatsApp.WhatsApp", appName: "WhatsApp", title: "Tim Produk", body: "Isi pesan pribadi tidak ditampilkan saat collapse.", createdAtMs: now, icon: null }];
    await publish(); await wait(650);
    const signal = document.querySelector(".notch-notification-signal");
    check(signal?.textContent.includes("Tim Produk") && signal.textContent.includes("WhatsApp"), "collapsed notification identifies sender and app");
    check(!document.querySelector(".notch-clock-row"), "notification owns the collapsed slot without clock or media overlap");
    check(!signal.textContent.includes("Isi pesan pribadi"), "collapsed preview omits message body");
    const shell = document.querySelector("[data-notch]").getBoundingClientRect();
    check(Math.abs(shell.width - 300) < 1 && Math.abs(shell.height - 46) < 1, "notification uses the same 300x46 footprint as volume and brightness");
    check(window.__notchCommands.some(({ command, args }) => command === "set_notch_hit" && args.width === 300 && args.height === 46 && args.clickThrough), "native hit area follows the notification footprint");
    const preview = signal.getBoundingClientRect();
    check(preview.left >= shell.left && preview.right <= shell.right && preview.top >= shell.top - 1 && preview.bottom <= shell.bottom + 1, "collapsed notification fits inside the shell");
  } else if (scenario === "spring-close") {
    const shell = document.querySelector("[data-notch]");
    await emit("notch-click-outside", null);
    const widths = [];
    const started = performance.now();
    while (performance.now() - started < 900) {
      await new Promise(requestAnimationFrame);
      widths.push(shell.getBoundingClientRect().width);
    }
    check(Math.abs(widths.at(-1) - 200) < 1, "closing settles at the idle width");
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) check(Math.min(...widths) < 199.5, "closing spring has a restrained elastic settle");
    await emit("notch-press", null); await wait(650);
    await emit("notch-click-outside", null); await wait(90);
    const beforeReverse = shell.getBoundingClientRect().width;
    await emit("notch-press", null); await new Promise(requestAnimationFrame);
    check(Math.abs(shell.getBoundingClientRect().width - beforeReverse) < 100, "reopening redirects the current shell without snapping to a target");
    await wait(750);
    check(shell.getAttribute("aria-expanded") === "true" && Math.abs(shell.getBoundingClientRect().width - 640) < 1, "mid-close reversal finishes open");
  } else if (scenario === "notification-size-cycle") {
    const shell = document.querySelector("[data-notch]");
    await emit("notch-click-outside", null); await wait(650);
    state.items = [{ ...items[0], id: 34, title: "Pesan masuk" }];
    await publish(); await wait(650);
    check(shell.dataset.shape === "notification" && Math.abs(shell.getBoundingClientRect().width - 300) < 1, "incoming notification expands the collapsed notch");
    await emit("hud-brightness", 65); await wait(450);
    check(shell.dataset.shape === "hud" && !document.querySelector(".notch-notification-layer"), "brightness takes priority without overlapping notification content");
    await wait(1700);
    check(shell.dataset.shape === "notification", "notification returns after the temporary brightness HUD");
    await emit("notch-press", null); await wait(650);
    const expanded = shell.getBoundingClientRect();
    const expandedHit = window.__notchCommands.filter(({ command }) => command === "set_notch_hit").at(-1)?.args;
    check(Math.abs(expanded.width - 544) < 1 && Math.abs(expanded.height - 156) < 1 && expandedHit?.width === 544 && expandedHit?.height === 156, "opening a collapsed notification uses the fitted visual and native size");
    await emit("notch-click-outside", null); await wait(650);
    check(shell.dataset.shape === "notification" && Math.abs(shell.getBoundingClientRect().width - 300) < 1, "expanded panel springs back to notification size");
    await wait(2100);
    check(shell.dataset.shape === "bar" && Math.abs(shell.getBoundingClientRect().width - 200) < 1, "expired notification springs back to idle size");
  } else if (scenario === "queue") {
    document.querySelector(".notification-next").click(); await wait(60);
    check(document.querySelector(".notification-interruption")?.textContent.includes("Rapat desain besok"), "next queued notification becomes active");
    document.querySelector(".notification-next").click(); await wait(60);
    check(document.querySelector(".notification-interruption")?.textContent.includes("Pertemuan tim"), "queue cycles without dismissing Windows notifications");
    await openTab();
    check(document.querySelectorAll(".notification-item").length === 1, "tab shows one focused notification");
    check(document.querySelector(".notification-next")?.textContent === "+1", "tab also exposes the remaining inbox");
    check(tab().querySelector(".notch-tab-badge")?.textContent === "2", "count badge matches inbox");
  } else if (scenario === "closed") {
    await emit("notch-click-outside", null); await wait(650);
    check(document.querySelector("[data-notch]").getAttribute("aria-expanded") === "false", "notch closes");
    state.items = [{ ...items[0], id: 23, title: "Pesan baru" }, ...items];
    await publish(); await wait(120);
    check(document.querySelector(".notch-notification-signal-dot"), `new notification pulses in closed notch; state=${state.access}/${state.items.length}; clock=${!!document.querySelector('.notch-clock-row')}`);
    state.items = structuredClone(items); await publish();
    await openTab();
  } else if (scenario === "lifetime") {
    state.items = [{ ...items[0], id: 24, title: "Pengingat baru" }, ...items];
    await publish(); await wait(120);
    check(document.querySelector(".notification-interruption"), "new message interrupts the open notch");
    await wait(8200);
    check(document.querySelector(".notification-interruption"), "expanded message remains while the user is present");
    await emit("notch-click-outside", null); await wait(2800);
    check(!document.querySelector(".notch-notification-signal-dot"), "closed interruption expires after two seconds");
    state.items = structuredClone(items); await publish();
  } else if (scenario === "filter") {
    document.querySelector('[aria-label="Saring aplikasi"]').click(); await wait(60);
    const radios = document.querySelectorAll('.notification-filter-panel input[type="radio"]');
    radios[1].click(); await wait(60);
    document.querySelector('.notification-app-options input[type="checkbox"]').click(); await wait(60);
    check(document.querySelectorAll(".notification-item").length === 1 && !document.querySelector(".notification-next"), "selected app filters the queue");
    check(tab().querySelector(".notch-tab-badge")?.textContent === "1", "badge uses filtered count");
    radios[0].click(); await wait(60);
    document.querySelector('[aria-label="Tutup saringan"]').click(); await wait(60);
    check(document.querySelectorAll(".notification-item").length === 1 && document.querySelector(".notification-next"), "all apps restores the queue");
  } else if (scenario === "filter-keyboard") {
    const trigger = document.querySelector('[aria-label="Saring aplikasi"]');
    trigger.click(); await wait(80);
    check(document.activeElement?.matches('.notification-filter-panel input:checked'), "filter moves focus to the active choice");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(450);
    check(!document.querySelector(".notification-filter-panel") && document.activeElement === trigger, "Escape closes the filter and restores focus");
  } else if (scenario === "dismiss") {
    document.querySelector(".notification-dismiss").click(); await wait(100);
    check(state.items.length === 1 && document.querySelectorAll(".notification-item").length === 1, "dismiss updates source and UI");
  } else if (scenario === "clear") {
    document.querySelector(".notification-actions button:nth-child(2)").click(); await wait(100);
    check(state.items.length === 0, "clear passes only shown ids");
    check(document.querySelector(".notification-empty")?.textContent.includes("Tidak ada notifikasi aktif"), "empty after clear");
  } else if (scenario === "denied") {
    state.access = "denied"; state.message = "Akses ditolak di Windows."; state.items = []; await publish(); await wait(100);
    check(document.querySelector(".notification-empty")?.textContent.includes("Akses ditolak di Windows"), "denied reason visible");
  }
  const tabBounds = document.querySelector(".notch-notifications")?.getBoundingClientRect();
  const liveBounds = document.querySelector(".notification-interruption")?.getBoundingClientRect();
  check(tabBounds ? tabBounds.width <= 641 && tabBounds.height === 148 : liveBounds ? liveBounds.width <= 641 && liveBounds.height <= 180 : document.querySelector("[data-notch]")?.getAttribute("aria-expanded") === "false", "notification view fits notch");
  return { scenario, ok: true, count: state.items.length };
};
