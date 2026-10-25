import { emit } from "@tauri-apps/api/event";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Same logical viewport as the desktop window (800x320): the panel is 640 wide
// (752 with a pinned column) and its opening spring peaks wider still, so a
// smaller viewport would clip geometry the window was sized to hold.

export async function runPanelScenario(scenario = "open") {
  const rows = [], errors = [];
  const check = (ok, reason) => { if (!ok) errors.push(reason); };
  const start = performance.now();
  const state = () => {
    const notch = document.querySelector("[data-notch]");
    const body = notch.querySelector(".notch-body");
    const tabs = [...notch.querySelectorAll("[role=tab]")];
    const panel = notch.querySelector(".notch-tab-panel");
    const pill = notch.querySelector(".notch-tab-pill");
    const style = panel ? getComputedStyle(panel) : null;
    const matrix = style ? style.transform : "none";
    const x = matrix === "none" ? 0 : Number(matrix.replace(/[^-,0-9]/g, "").split(",")[4] ?? 0);
    return {
      t: performance.now() - start,
      open: notch.getAttribute("aria-expanded") === "true",
      hidden: notch.getAttribute("aria-hidden") === "true",
      width: notch.getBoundingClientRect().width,
      height: notch.getBoundingClientRect().height,
      radius: getComputedStyle(notch).borderBottomLeftRadius,
      ear: getComputedStyle(notch).getPropertyValue("--ear-size").trim(),
      colour: getComputedStyle(body).getPropertyValue("--notch-color").replace(/\s/g, ""),
      tablist: notch.querySelectorAll("[role=tablist]").length,
      tabs: tabs.map((tab) => ({ id: tab.dataset.tabId, label: tab.getAttribute("aria-label") ?? "", selected: tab.getAttribute("aria-selected") })),
      panelId: panel?.dataset.tabId ?? "",
      panels: notch.querySelectorAll("[role=tabpanel]").length,
      panel: style ? { x, opacity: Number(style.opacity), blur: style.filter, height: parseFloat(style.height) } : null,
      pill: pill
        ? { at: pill.closest("[role=tab]")?.dataset.tabId ?? "", left: pill.getBoundingClientRect().left, width: pill.getBoundingClientRect().width }
        : null,
      emptyText: notch.querySelector(".notch-tab-empty")?.textContent ?? "",
      hasNook: !!notch.querySelector(".notch-nook"),
    };
  };
  rows.push(state());
  const timer = setInterval(() => rows.push(state()), 16);
  const clickTab = (id) => {
    const tab = [...document.querySelectorAll("[role=tab]")].find((candidate) => candidate.dataset.tabId === id);
    tab?.click();
  };

  /** Opens the panel and verifies shell, tab bar and resting empty state. */
  await emit("notch-press", null);
  await wait(800);
  const settled = rows.at(-1);
  check(settled.open, "panel opens");
  check(Math.abs(settled.width - 640) < 3, `open width 640, got ${settled.width.toFixed(1)}`);
  check(Math.abs(settled.height - 200) < 3, `open height 200, got ${settled.height.toFixed(1)}`);
  check(settled.radius === "24px", `open radius 24, got ${settled.radius}`);
  check(settled.ear === "14px", `open ear 14, got ${settled.ear}`);
  check(settled.colour === "#000000", `notch colour #000, got ${settled.colour}`);
  check(!settled.hidden, "not re-hidden by autohide in the fixture");
  check(settled.tablist === 1, "one role=tablist");
  check(settled.panels === 1, "one role=tabpanel at a time (mode wait)");
  check(settled.tabs.length === 4, `four role=tab buttons, got ${settled.tabs.length}`);
  check(settled.tabs.map((tab) => tab.label).join() === "Nook,Tray,Sharing,Notif", `tab order, got ${settled.tabs.map((tab) => tab.label)}`);
  check(settled.tabs.filter((tab) => tab.selected === "true").length === 1, "exactly one aria-selected");
  check(settled.tabs[0].selected === "true" && settled.tabs[0].id === "nook", "Nook selected first");
  check(settled.panelId === "nook", "first tabpanel is Nook");
  check(settled.panel.opacity > 0.95, "panel body fully faded in");
  check(Math.abs(settled.panel.x) < 0.5, "panel body at rest");
  check(!settled.panel.blur.includes("8px") && !settled.panel.blur.includes("6px"), "panel body unblurred at rest");
  check(settled.emptyText.includes("Nook") || settled.hasNook, `Nook tab content mounted, got "${settled.emptyText}"`);
  check(!!settled.pill, "active pill rendered");
  check(Math.abs(settled.pill.width) > 24, "pill covers the icon capsule");
  const nookPillLeft = settled.pill.left;

  if (scenario === "next") {
    // Nook -> Sharing: the pill flies right while the old content leaves to
    // the left and the new one arrives from the right.
    clickTab("sharing");
    await wait(320);
    const flew = rows.filter((s) => s.t > settled.t + 8 && s.open && s.panelId === "nook");
    check(flew.length > 1, "old panel seen leaving");
    check(flew.every((s) => s.panel.x <= 0.5), `old content exits left (negative x), min ${Math.min(...flew.map((s) => s.panel.x)).toFixed(1)}`);
    const arrived = rows.filter((s) => s.panelId === "sharing");
    check(arrived.some((s) => s.panel.x > 8), "new content enters from the right");
    const reached = rows.filter((s) => s.pill && s.pill.at === "sharing");
    const targetLeft = document.querySelector('[role="tab"][data-tab-id="sharing"]').getBoundingClientRect().left;
    // The pill is mounted inside the target button from the first frame and
    // layout-animates from Nook's position to Sharing's.
    check(reached.some((s) => s.pill.left < nookPillLeft + 12) && reached.some((s) => s.pill.left > nookPillLeft + 40), "pill covers the distance to Sharing");
    // A damped spring may cross its destination and settle back. Require
    // rightward travel until the target, with only a small settling overshoot;
    // strict per-frame monotonicity fails depending on the sampling cadence.
    check(reached.every((s, i, all) => (i === 0 || s.pill.left >= Math.min(all[i - 1].pill.left, targetLeft) - 1)
      && s.pill.left <= targetLeft + (targetLeft - nookPillLeft) * 0.04 + 1), `pill travels rightward with bounded spring settling, path ${reached.map((s) => s.pill.left.toFixed(0)).join("→")}`);
    check(rows.filter((s) => s.tabs.length === 4).every((s) => s.tabs.filter((tab) => tab.selected === "true").length === 1), "still exactly one selected while flying");
    await wait(400);
    const end = state();
    check(end.panelId === "sharing" && end.panel.opacity > 0.95 && Math.abs(end.panel.x) < 0.5 && !end.panel.blur.includes("6px"), "sharing content at rest");
    check(end.tabs[2].selected === "true", "aria-selected on Sharing");
    check(end.pill.at === "sharing", "pill rests under Sharing");
    check(Math.abs(end.pill.left - targetLeft) < 1, "pill settles at the target, not at its overshoot");
  } else if (scenario === "prev") {
    clickTab("notification");
    await wait(320);
    check(rows.filter((s) => s.panelId === "notification").some((s) => s.panel.x > 8), "Notif content enters from the right");
    clickTab("nook");
    await wait(240);
    const goneRight = rows.filter((s) => s.panelId === "notification" && s.open);
    check(goneRight.some((s) => s.panel.x > 8), `leaving leftward tab exits to the RIGHT, max ${Math.max(...goneRight.map((s) => s.panel.x)).toFixed(1)}`);
    const arrived = rows.filter((s) => s.panelId === "nook");
    check(arrived.some((s) => s.panel.x < -8), "new content enters from the LEFT");
    await wait(400);
    const end = state();
    check(end.panelId === "nook" && end.panel.opacity > 0.95 && Math.abs(end.panel.x) < 0.5, "nook content at rest");
  } else if (scenario === "outside") {
    await emit("notch-click-outside", null);
    await wait(700);
    const end = state();
    check(!end.open, "outside click closes the panel");
    check(Math.abs(end.width - 200) < 3 && Math.abs(end.height - 34) < 3, `collapsed back to 200x34, got ${end.width.toFixed(1)}x${end.height.toFixed(1)}`);
    check(end.ear === "6px", "ear back to 6");
  }
  clearInterval(timer);
  const transitions = rows.filter((s, i) => !i || s.panelId !== rows[i - 1].panelId || s.open !== rows[i - 1].open);
  window.__panelProbe = { scenario, rows, errors, transitions };
  if (errors.length) throw new Error(errors.join("; "));
  return { scenario, errors, transitions, final: state() };
}
