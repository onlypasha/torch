import { emit } from "@tauri-apps/api/event";

/**
 * Browser-only Nook checks. The real app is mounted with mocked Tauri IPC and
 * mocked events, so the native media worker is replaced by `media-state`
 * events emitted from here; everything below the event boundary is the real
 * component and the real state hook.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notch = () => document.querySelector("[data-notch]");
const stackEl = () => notch()?.querySelector(".notch-stack");
const activeCard = () => notch()?.querySelector('.notch-stack-card[data-slot="active"]');
const pinnedCards = () => [...(notch()?.querySelectorAll(".notch-pin-card") ?? [])];
const menuEl = () => notch()?.querySelector(".notch-menu");

const TRACK = {
  title: "Malam Ini",
  artist: "Contoh Band",
  album: "Album Demo",
  playing: true,
  positionMs: 61_000,
  durationMs: 180_000,
  thumbnail: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  canPrevious: true,
  canNext: true,
  canToggle: true,
  source: "Spotify.exe",
};

function state() {
  const n = notch();
  const s = stackEl();
  const times = [...(n?.querySelectorAll(".notch-media-times span") ?? [])];
  const track = n?.querySelector(".notch-media-track");
  const fill = n?.querySelector(".notch-media-fill");
  const pinPomodoro = n?.querySelector('.notch-pin-card[data-widget="pomodoro"]');
  const stackPomodoro = s?.querySelector('.notch-stack-card[data-widget="pomodoro"]');
  const cards = pinnedCards();
  const cover = n?.querySelector(".notch-media-cover");
  return {
    open: n?.getAttribute("aria-expanded") === "true",
    width: n?.getBoundingClientRect().width ?? 0,
    height: n?.getBoundingClientRect().height ?? 0,
    active: activeCard()?.dataset.widget ?? "",
    slots: [...(s?.querySelectorAll(".notch-stack-card") ?? [])]
      .map((card) => `${card.dataset.widget}:${card.dataset.slot}`)
      .join(","),
    pinned: cards.map((card) => card.dataset.widget),
    pinHeights: cards.map((card) => card.getBoundingClientRect().height),
    menu: menuEl()?.querySelector(".notch-menu-item")?.textContent ?? "",
    menuDisabled: !!menuEl()?.querySelector(".notch-menu-item")?.disabled,
    menuRect: menuEl() ? menuEl().getBoundingClientRect() : null,
    title: n?.querySelector(".notch-media-title")?.textContent ?? "",
    artist: n?.querySelector(".notch-media-artist")?.textContent ?? "",
    cover: cover ? getComputedStyle(cover).backgroundImage : "",
    current: times[0]?.textContent ?? "",
    duration: times[1]?.textContent ?? "",
    play: n?.querySelector(".notch-media-play")?.getAttribute("aria-label") ?? "",
    playDisabled: !!n?.querySelector(".notch-media-play")?.disabled,
    fill: track && fill ? fill.getBoundingClientRect().width / Math.max(1, track.getBoundingClientRect().width) : 0,
    stackTime: stackPomodoro?.querySelector(".notch-pomodoro-time")?.textContent ?? "",
    stackStart: stackPomodoro?.querySelector(".notch-pill-light")?.textContent ?? "",
    pinnedTime: pinPomodoro?.querySelector(".notch-pin-time")?.textContent ?? "",
    pinnedStatus: pinPomodoro?.querySelector(".notch-pin-status")?.textContent ?? "",
    pinnedPhase: pinPomodoro?.dataset.phase ?? "",
    pinnedPressed: pinPomodoro?.getAttribute("aria-pressed") ?? "",
    pinnedRing: !!pinPomodoro?.querySelector(".notch-pin-progress"),
    pinFill: pinPomodoro?.querySelector(".notch-pin-progress")?.style.getPropertyValue("--fill") ?? "",
    scrollTop: document.scrollingElement?.scrollTop ?? 0,
  };
}

const seconds = (clock) => {
  const [minutes, rest] = clock.split(":").map(Number);
  return minutes * 60 + (rest || 0);
};

const openPanel = async () => {
  await emit("notch-press", null);
  await wait(900);
};

const wheel = (element, deltaY) => {
  element.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
};

const press = (element, key, extra = {}) => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
};

const contextMenu = (element) => {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
};

const clickMenu = () => menuEl()?.querySelector(".notch-menu-item")?.click();

const clickTab = (id) => {
  [...(notch()?.querySelectorAll("[role=tab]") ?? [])]
    .find((tab) => tab.dataset.tabId === id)
    ?.click();
};

const pinActive = async () => {
  contextMenu(activeCard());
  await wait(140);
  clickMenu();
  await wait(950);
};

/** Synthetic pointer drag; returns whether framer moved the card at all. */
async function drag(element, dy) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const init = {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...init, button: 0, buttons: 1 }));
  await wait(60);
  window.dispatchEvent(new PointerEvent("pointermove", { ...init, buttons: 1, clientY: y + dy / 2 }));
  await wait(60);
  window.dispatchEvent(new PointerEvent("pointermove", { ...init, buttons: 1, clientY: y + dy }));
  await wait(60);
  window.dispatchEvent(new PointerEvent("pointerup", { ...init, button: 0, clientY: y + dy }));
  await wait(700);
}

export async function runNookScenario(scenario = "media") {
  const errors = [];
  const samples = [];
  const check = (ok, reason) => { if (!ok) errors.push(reason); };
  const sample = () => { const value = state(); samples.push(value); return value; };

  if (scenario === "media") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1400);
    let now = sample();
    check(now.title === "Malam Ini", `title from the media event, got "${now.title}"`);
    check(now.artist === "Contoh Band", `artist from the media event, got "${now.artist}"`);
    check(now.current === "1:01", `current time 1:01, got "${now.current}"`);
    check(now.duration === "3:00", `duration 3:00, got "${now.duration}"`);
    check(now.play === "Jeda", `playing session shows Jeda, got "${now.play}"`);
    check(now.fill > 0.2 && now.fill < 0.45, `progress near 34%, got ${(now.fill * 100).toFixed(1)}%`);
    check(now.cover.includes("data:image/png"), "album art becomes the cover");

    const controlCount = () => window.__notchCommands.filter((entry) => entry.command === "media_control").length;
    const before = controlCount();
    notch().querySelector('[aria-label="Lagu berikutnya"]').click();
    await wait(80);
    const calls = window.__notchCommands.filter((entry) => entry.command === "media_control");
    check(controlCount() === before + 1, "next sends one media_control command");
    check(calls.at(-1)?.args?.action === "next", `next action, got ${JSON.stringify(calls.at(-1)?.args)}`);

    // A later poll of the same track omits the (large) art; the panel keeps it.
    await emit("media-state", { ...TRACK, thumbnail: undefined, positionMs: 90_000, playing: false });
    await wait(500);
    now = sample();
    check(now.play === "Putar", `paused session shows Putar, got "${now.play}"`);
    check(now.fill > 0.42 && now.fill < 0.58, `paused progress near 50%, got ${(now.fill * 100).toFixed(1)}%`);
    check(now.cover.includes("data:image/png"), "cover survives a poll without art");

    await emit("media-state", null);
    await wait(400);
    now = sample();
    check(now.title === "Tidak ada media", `no session is explicit, got "${now.title}"`);
    check(now.playDisabled, "transport disabled without a session");
  }

  if (scenario === "stack") {
    await openPanel();
    const before = sample();
    check(before.active === "calendar", `calendar is active first, got ${before.active}`);

    wheel(stackEl(), 120);
    await wait(140);
    wheel(stackEl(), 120);
    await wait(400);
    let now = sample();
    check(now.active === "pomodoro", `wheel down advances to pomodoro and a second wheel inside the cooldown is ignored, got ${now.active}`);
    check(
      now.slots === "calendar:previous,pomodoro:active,lyric:next,weather:further",
      `slot order after one step, got ${now.slots}`,
    );
    const inactive = notch().querySelector('.notch-stack-card[data-slot="next"]');
    check(getComputedStyle(inactive).pointerEvents === "none", "only the active card is interactive");

    await wait(350);
    wheel(stackEl(), 120);
    await wait(500);
    now = sample();
    check(now.active === "lyric", `next wheel step reaches lyric, got ${now.active}`);

    stackEl().focus();
    press(stackEl(), "ArrowDown");
    await wait(500);
    now = sample();
    check(now.active === "weather", `ArrowDown advances, got ${now.active}`);
    press(stackEl(), "ArrowUp");
    await wait(500);
    now = sample();
    check(now.active === "lyric", `ArrowUp goes back, got ${now.active}`);
    check(now.scrollTop === 0 && before.scrollTop === 0, "the stack wheel never scrolls the page");
    check(now.width === 520, `the stack keeps the 520 shape, got ${now.width}`);
  }

  if (scenario === "pin") {
    await openPanel();
    contextMenu(activeCard());
    await wait(160);
    let now = sample();
    check(now.menu === "Pin widget", `menu offers Pin widget, got "${now.menu}"`);
    check(!now.menuDisabled, "Pin is enabled with an empty column");
    const exitMenus = window.__notchCommands.filter((entry) => entry.command === "show_notch_menu").length;

    clickMenu();
    await wait(1000);
    now = sample();
    check(now.pinned.join() === "calendar", `calendar pinned, got ${now.pinned}`);
    check(Math.abs(now.width - 642) < 4, `pinning widens to 642, got ${now.width.toFixed(1)}`);
    check(Math.abs(now.height - 236) < 3, `height stays 236, got ${now.height.toFixed(1)}`);
    check(now.pinHeights.length === 1 && Math.abs(now.pinHeights[0] - 149) < 2, `one pin fills the column, got ${now.pinHeights}`);
    check(notch().querySelectorAll(".notch-stack-card").length === 3, "pinned widget leaves the stack");
    check(now.open, "pinning does not close the panel");
    check(
      window.__notchCommands.filter((entry) => entry.command === "show_notch_menu").length === exitMenus,
      "the widget menu does not trigger the native notch menu",
    );

    clickTab("tray");
    await wait(700);
    now = sample();
    check(Math.abs(now.width - 520) < 4, `Tray returns to 520, got ${now.width.toFixed(1)}`);
    clickTab("nook");
    await wait(900);
    now = sample();
    check(Math.abs(now.width - 642) < 4, `back on Nook widens again, got ${now.width.toFixed(1)}`);
    check(now.pinned.join() === "calendar", "the pin survives a tab switch");

    contextMenu(pinnedCards()[0]);
    await wait(160);
    now = sample();
    check(now.menu === "Unpin widget", `pinned menu offers Unpin, got "${now.menu}"`);
    clickMenu();
    await wait(900);
    now = sample();
    check(now.pinned.length === 0, "unpin empties the column");
    check(Math.abs(now.width - 520) < 4, `unpinning narrows to 520, got ${now.width.toFixed(1)}`);
    check(notch().querySelectorAll(".notch-stack-card").length === 4, "the widget returns to the stack");
    check(now.open, "unpinning does not close the panel");
  }

  if (scenario === "pinlimit") {
    await openPanel();
    await pinActive();
    // Pinning the active card hands the stack to the next widget, which is
    // what the second pin uses.
    await pinActive();
    let now = sample();
    check(now.pinned.join() === "calendar,pomodoro", `two pins in order, got ${now.pinned}`);
    check(Math.abs(now.width - 642) < 4, `still 642 with two pins, got ${now.width.toFixed(1)}`);
    check(now.pinHeights.length === 2, "two pinned cards");
    check(Math.abs(now.pinHeights[0] - now.pinHeights[1]) < 2, `split heights equal, got ${now.pinHeights}`);
    check(Math.abs(now.pinHeights[0] + now.pinHeights[1] + 8 - 149) < 3, `two cards and the gap fill 149, got ${now.pinHeights}`);

    // A third pin must be refused: right-click the remaining stack card.
    contextMenu(activeCard());
    await wait(160);
    now = sample();
    check(now.menu === "Pin penuh (maks. 2)", `full column label, got "${now.menu}"`);
    check(now.menuDisabled, "third pin is disabled");
    press(window, "Escape");
    await wait(200);

    const before = now.pinned.join();
    await drag(pinnedCards()[0], 60);
    now = sample();
    check(now.pinned.join() === "pomodoro,calendar", `drag down swaps the pins, got ${now.pinned}`);
    check(now.pinned.join() !== before, "drag actually changed the order");
    await drag(pinnedCards()[1], -60);
    now = sample();
    check(now.pinned.join() === "calendar,pomodoro", `drag up swaps back, got ${now.pinned}`);
    check(now.open, "reordering does not close the panel");
  }

  if (scenario === "timer") {
    await openPanel();
    wheel(stackEl(), 120);
    await wait(500);
    let now = sample();
    check(now.active === "pomodoro", "pomodoro reached through the stack");
    check(now.stackTime === "25:00", `timer starts at 25:00, got ${now.stackTime}`);
    check(now.stackStart === "Mulai", `starts paused, got "${now.stackStart}"`);

    notch().querySelector('.notch-stack-card[data-widget="pomodoro"] .notch-pill-light').click();
    await wait(1700);
    now = sample();
    check(now.stackStart === "Jeda", `running button says Jeda, got "${now.stackStart}"`);
    check(seconds(now.stackTime) <= 24 * 60 + 59 && seconds(now.stackTime) >= 24 * 60 + 56, `timer ticking, got ${now.stackTime}`);

    await pinActive();
    now = sample();
    check(now.pinned.join() === "pomodoro", "pomodoro pinned while running");
    check(now.pinnedPressed === "true" && now.pinnedPhase === "running", `pinned pomodoro is running, got ${now.pinnedPhase}/${now.pinnedPressed}`);
    check(now.pinnedRing, "pinned pomodoro draws its border progress");
    check(
      Number(now.pinFill) > 0.9 && Number(now.pinFill) <= 1,
      `border fill follows the remaining time, got "${now.pinFill}"`,
    );
    check(now.pinnedStatus === "Fokus", `status Fokus, got "${now.pinnedStatus}"`);

    pinnedCards()[0].click();
    await wait(500);
    now = sample();
    check(now.pinnedPressed === "false" && now.pinnedPhase === "paused", `click pauses, got ${now.pinnedPhase}/${now.pinnedPressed}`);
    check(now.pinnedStatus === "Jeda", `status Jeda, got "${now.pinnedStatus}"`);
    const pausedClock = now.pinnedTime;
    await wait(1300);
    now = sample();
    check(now.pinnedTime === pausedClock, `paused clock is still, got ${pausedClock} -> ${now.pinnedTime}`);

    clickTab("tray");
    await wait(600);
    clickTab("nook");
    await wait(800);
    now = sample();
    check(now.pinned.join() === "pomodoro", "pin persists across tabs");
    check(now.pinnedTime === pausedClock, `timer state persists across tabs, got ${now.pinnedTime}`);

    pinnedCards()[0].click();
    await wait(800);
    now = sample();
    check(now.pinnedPressed === "true" && now.pinnedPhase === "running", `click resumes, got ${now.pinnedPhase}/${now.pinnedPressed}`);
  }

  if (scenario === "menu") {
    await openPanel();
    const nativeMenus = () => window.__notchCommands.filter((entry) => entry.command === "show_notch_menu").length;
    const before = nativeMenus();

    contextMenu(activeCard());
    await wait(160);
    let now = sample();
    check(!!now.menu, "right-click opens the widget menu");
    const rect = now.menuRect;
    check(rect.left >= 0 && rect.right <= window.innerWidth, "menu stays inside the panel horizontally");
    check(rect.top >= 0 && rect.bottom <= window.innerHeight, "menu stays inside the panel vertically");

    press(window, "Escape");
    await wait(220);
    now = sample();
    check(!now.menu, "Escape closes the menu");

    contextMenu(activeCard());
    await wait(160);
    check(!!sample().menu, "menu reopens");
    notch().querySelector(".notch-media").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await wait(220);
    check(!sample().menu, "pointer outside closes the menu");

    stackEl().focus();
    press(stackEl(), "F10", { shiftKey: true });
    await wait(180);
    check(!!sample().menu, "Shift+F10 opens the menu");
    press(window, "Escape");
    await wait(180);

    press(stackEl(), "ContextMenu");
    await wait(180);
    check(!!sample().menu, "the ContextMenu key opens the menu");
    press(window, "Escape");
    await wait(200);

    check(nativeMenus() === before, "none of the menu paths reach the native notch menu");
    check(sample().open, "menu interaction leaves the panel open");
  }

  if (scenario === "collapsed") {
    await openPanel();
    await pinActive();
    let now = sample();
    check(now.pinned.join() === "calendar", "pin exists before closing");
    await emit("notch-click-outside", null);
    await wait(700);
    now = sample();
    check(!now.open, "outside click closes the wide panel");
    check(Math.abs(now.width - 200) < 3 && Math.abs(now.height - 34) < 3, `collapses to 200x34, got ${now.width.toFixed(1)}x${now.height.toFixed(1)}`);
    await emit("notch-press", null);
    await wait(900);
    now = sample();
    check(now.open, "reopens");
    check(Math.abs(now.width - 520) < 4, `a fresh panel is 520 again, got ${now.width.toFixed(1)}`);
    check(now.pinned.length === 0, "pins do not survive the panel closing");
  }

  if (scenario === "showcase0") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1300);
    sample();
  }

  if (scenario === "showcase") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1300);
    await pinActive();
    await wait(400);
    sample();
  }

  if (scenario === "showcase2") {
    await openPanel();
    wheel(stackEl(), 120);
    await wait(500);
    notch().querySelector('.notch-stack-card[data-widget="pomodoro"] .notch-pill-light').click();
    await wait(1200);
    await pinActive();
    await pinActive();
    await wait(700);
    sample();
  }

  if (scenario === "showcase3") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1300);
    await pinActive();
    await wait(500);
    contextMenu(pinnedCards()[0]);
    await wait(300);
    sample();
  }

  window.__nookProbe = { scenario, errors, samples };
  if (errors.length) throw new Error(errors.join("; "));
  return { scenario, errors, final: state() };
}
