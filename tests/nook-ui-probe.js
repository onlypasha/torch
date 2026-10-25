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
  hasTimeline: true,
  thumbnail: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  canPrevious: true,
  canNext: true,
  canToggle: true,
  canSeek: true,
  shuffle: false,
  shuffleSupported: true,
  repeat: "none",
  repeatSupported: true,
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
  const lyricCard = s?.querySelector('.notch-stack-card[data-widget="lyric"]');
  const shuffle = n?.querySelector('.notch-media-toggle[aria-label="Acak lagu"]');
  const repeat = n?.querySelector('.notch-media-toggle[aria-label^="Repeat"]');
  const media = n?.querySelector(".notch-media");
  const pinned = n?.querySelector(".notch-pinned");
  const bounds = n?.getBoundingClientRect();
  const columns = [media, s, pinned].filter(Boolean);
  const clock = n?.querySelector(".notch-clock-time")?.getBoundingClientRect();
  const status = n?.querySelector(".notch-clock-status")?.getBoundingClientRect();
  return {
    open: n?.getAttribute("aria-expanded") === "true",
    width: n?.getBoundingClientRect().width ?? 0,
    height: n?.getBoundingClientRect().height ?? 0,
    mediaWidth: media?.getBoundingClientRect().width ?? 0,
    stackWidth: s?.getBoundingClientRect().width ?? 0,
    pinnedWidth: pinned?.getBoundingClientRect().width ?? 0,
    columnsFit: columns.every((column) => {
      const rect = column.getBoundingClientRect();
      return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1;
    }),
    nativeHit: window.__notchCommands.filter((entry) => entry.command === "set_notch_hit").at(-1)?.args,
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
    lyric: n?.querySelector(".notch-media-lyric-line")?.textContent ?? "",
    cover: cover ? getComputedStyle(cover).backgroundImage : "",
    current: times[0]?.textContent ?? "",
    duration: times[1]?.textContent ?? "",
    notice: times[1]?.dataset.notice ?? "",
    play: n?.querySelector(".notch-media-play")?.getAttribute("aria-label") ?? "",
    playDisabled: !!n?.querySelector(".notch-media-play")?.disabled,
    fill: track && fill ? fill.getBoundingClientRect().width / Math.max(1, track.getBoundingClientRect().width) : 0,
    seekable: track?.dataset.interactive === "true",
    shufflePressed: shuffle?.getAttribute("aria-pressed") ?? "",
    shuffleColor: shuffle ? getComputedStyle(shuffle).color : "",
    repeatLabel: repeat?.getAttribute("aria-label") ?? "",
    repeatOne: !!n?.querySelector(".notch-media-repeat-one"),
    lyrics: [...(lyricCard?.querySelectorAll(".notch-lyric-line") ?? [])].map((row) => ({
      text: row.textContent,
      current: row.dataset.current === "true",
      status: row.dataset.status ?? "",
    })),
    stackTime: stackPomodoro?.querySelector(".notch-pomodoro-time")?.textContent ?? "",
    stackStart: stackPomodoro?.querySelector(".notch-pill-light")?.textContent ?? "",
    timerMode: stackPomodoro?.querySelector(".notch-pomodoro-mode")?.textContent.trim() ?? "",
    timerModeLabel: stackPomodoro?.querySelector(".notch-pomodoro-mode-label")?.textContent ?? "",
    pinnedTime: pinPomodoro?.querySelector(".notch-pin-time")?.textContent ?? "",
    pinnedStatus: pinPomodoro?.querySelector(".notch-pin-status")?.textContent ?? "",
    pinnedPhase: pinPomodoro?.dataset.phase ?? "",
    pinnedPressed: pinPomodoro?.getAttribute("aria-pressed") ?? "",
    pinnedRing: !!pinPomodoro?.querySelector(".notch-pin-progress"),
    pinFill: pinPomodoro?.querySelector(".notch-pin-progress")?.style.getPropertyValue("--fill") ?? "",
    clockMedia: !!n?.querySelector(".notch-clock-media"),
    clockBars: n?.querySelectorAll(".notch-clock-bar").length ?? 0,
    clockTimerPhase: n?.querySelector(".notch-clock-timer")?.dataset.phase ?? "",
    clockTimerText: n?.querySelector(".notch-clock-timer > span")?.textContent ?? "",
    clockCentered: !!clock && Math.abs(clock.left + clock.width / 2 - (bounds.left + bounds.width / 2)) < 0.5
      && Math.abs(clock.top + clock.height / 2 - (bounds.top + bounds.height / 2)) < 0.5,
    clockStatusFits: !status || (status.left > clock.right + 4 && status.right <= bounds.right - 6),
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

/**
 * Rotate the stack until `id` is the active widget. The widget order is a
 * product decision (Quick Settings first), so probes should not encode an
 * exact number of steps from day one.
 */
const selectWidget = async (id) => {
  for (let step = 0; step < 8 && activeCard()?.dataset.widget !== id; step += 1) {
    wheel(stackEl(), 120);
    await wait(340);
  }
  await wait(260);
  return activeCard()?.dataset.widget ?? "";
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

/** Synthetic pointer step; the seek bar has no capture in a headless page. */
const pointer = (element, type, clientX) => {
  element.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX,
    clientY: element.getBoundingClientRect().top + 4,
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

  if (scenario === "compact") {
    await openPanel();
    await emit("media-state", TRACK);
    await selectWidget("calendar");
    await wait(400);
    const checkSize = (wide) => {
      const now = sample();
      const width = wide ? 752 : 640;
      check(Math.abs(now.width - width) < 1 && Math.abs(now.height - 200) < 1, `compact shape is ${width}x200`);
      check(Math.abs(now.mediaWidth - 352) < 1 && Math.abs(now.stackWidth - 252) < 1, "media and widget retain their compact widths");
      check(now.columnsFit, "compact columns remain inside the notch");
      check(now.nativeHit?.width === width && now.nativeHit?.height === 200 && now.nativeHit?.clickThrough === false, "native hit rect follows the compact silhouette");
      if (wide) check(Math.abs(now.pinnedWidth - 100) < 1, "pinned column is 100px wide");
    };
    checkSize(false);
    check([...notch().querySelectorAll(".notch-stack-card")].every((card) => card.inert === (card.dataset.slot !== "active")), "only the active widget exposes keyboard controls");
    const cover = notch().querySelector(".notch-media-cover").getBoundingClientRect();
    check(Math.abs(cover.width - 96) < 1 && Math.abs(cover.height - 96) < 1, "artwork is 96x96 without changing the card height");
    const mediaRect = notch().querySelector(".notch-media").getBoundingClientRect();
    check([...notch().querySelectorAll(".notch-media-controls button")].every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= mediaRect.left && rect.right <= mediaRect.right;
    }), "all transport controls fit without scaling text or buttons");
    check([...notch().querySelectorAll(".notch-media-meta, .notch-media-lyric, .notch-media-progress, .notch-media-controls")].every((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= mediaRect.top + 8 && rect.bottom <= mediaRect.bottom - 8;
    }), "all media rows stay inside the 148px card");
    await pinActive();
    checkSize(true);
    clickTab("tray");
    await wait(700);
    check(Math.abs(sample().width - 640) < 1 && sample().nativeHit?.width === 640, "other tabs return to the 640px hit rect");
    clickTab("nook");
    await wait(900);
    checkSize(true);
    await emit("notch-click-outside", null);
    await wait(700);
    const closed = sample();
    check(!closed.open && Math.abs(closed.width - 200) < 1 && Math.abs(closed.height - 34) < 1, "outside click still closes to 200x34");
    check(closed.nativeHit?.width === 200 && closed.nativeHit?.clickThrough === true, "collapsed hit rect and click-through are unchanged");
  }

  if (scenario === "media") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1400);
    let now = sample();
    check(now.title === "Malam Ini", `title from the media event, got "${now.title}"`);
    check(now.artist === "Contoh Band", `artist from the media event, got "${now.artist}"`);
    check(now.current === "1:01" || now.current === "1:02", `current time 1:01/1:02 (the shared clock advances), got "${now.current}"`);
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

  if (scenario === "seek") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(300);

    const bar = notch().querySelector(".notch-media-track");
    const rect = bar.getBoundingClientRect();
    check(bar.dataset.interactive === "true", "a seekable session makes the bar interactive");
    check(bar.getAttribute("role") === "slider", "the bar announces itself as a slider");

    const seeks = () => window.__notchCommands.filter((entry) => entry.command === "media_seek");
    const before = seeks().length;

    pointer(bar, "pointerdown", rect.left + rect.width * 0.25);
    await wait(80);
    let now = sample();
    check(now.current === "0:45", `pressing previews 0:45, got "${now.current}"`);

    pointer(bar, "pointermove", rect.left + rect.width * 0.75);
    await wait(80);
    now = sample();
    check(now.current === "2:15", `dragging previews 2:15, got "${now.current}"`);
    check(seeks().length === before, "moving the thumb does not seek on every pixel");

    pointer(bar, "pointerup", rect.left + rect.width * 0.75);
    await wait(150);
    check(seeks().length === before + 1, "releasing sends exactly one seek");
    check(seeks().at(-1)?.args?.positionMs === 135000, `seek target 135000ms, got ${seeks().at(-1)?.args?.positionMs}`);

    now = sample();
    check(now.current === "2:15", `the bar holds the target until the player answers, got "${now.current}"`);
    check(now.notice === "", "no warning while the seek is in flight");

    await emit("media-state", { ...TRACK, positionMs: 135_000 });
    await emit("media-seek", { applied: true, positionMs: 135_000 });
    await wait(150);
    now = sample();
    check(now.current === "2:15" && now.notice === "", `a confirmed seek settles quietly, got "${now.current}"`);

    pointer(bar, "pointerdown", rect.left + rect.width * 0.05);
    pointer(bar, "pointerup", rect.left + rect.width * 0.05);
    await wait(150);
    await emit("media-seek", { applied: false, positionMs: 135_000 });
    await wait(150);
    now = sample();
    check(now.notice === "true", "a rejected seek is reported on the bar");
    check(now.duration === "Seek ditolak", `the notice replaces the duration, got "${now.duration}"`);

    // A player that cannot report a timeline gets a read-only bar.
    await emit("media-state", { ...TRACK, canSeek: false, hasTimeline: false });
    await wait(150);
    now = sample();
    check(!now.seekable, "a session without seeking keeps the bar static");
  }

  if (scenario === "shuffle") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(250);

    let now = sample();
    check(now.shufflePressed === "false", `shuffle starts off, got "${now.shufflePressed}"`);

    notch().querySelector('.notch-media-toggle[aria-label="Acak lagu"]').click();
    await wait(90);
    const shuffleCalls = window.__notchCommands.filter((entry) => entry.command === "media_shuffle");
    check(shuffleCalls.at(-1)?.args?.active === true, `shuffle asks for on, got ${JSON.stringify(shuffleCalls.at(-1)?.args)}`);

    await emit("media-state", { ...TRACK, shuffle: true });
    await wait(140);
    now = sample();
    check(now.shufflePressed === "true", "the player's own shuffle state is what the button shows");

    notch().querySelector('.notch-media-toggle[aria-label^="Repeat"]').click();
    await wait(90);
    check(
      window.__notchCommands.some((entry) => entry.command === "media_repeat"),
      "repeat cycles through the worker",
    );

    await emit("media-state", { ...TRACK, repeat: "track" });
    await wait(140);
    now = sample();
    check(now.repeatLabel === "Repeat satu", `repeat-one is labelled, got "${now.repeatLabel}"`);
    check(now.repeatOne, "repeat-one shows its badge");

    // A source that cannot shuffle must not show a button that does nothing.
    await emit("media-state", { ...TRACK, shuffleSupported: false, repeatSupported: false });
    await wait(160);
    now = sample();
    check(now.shufflePressed === "" && now.repeatLabel === "", "unsupported controls are hidden");
  }

  if (scenario === "lyrics") {
    const original = window.fetch;
    let calls = 0;
    let aborts = 0;
    const body = {
      syncedLyrics: "[00:00.00]Awal lagu\n[00:30.00]Tengah lagu\n[01:00.00]Akhir lagu",
      duration: 180,
      trackName: "Malam Ini",
      artistName: "Contoh Band",
    };
    window.fetch = async (input, options) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 800);
        options.signal.addEventListener("abort", () => {
          aborts += 1;
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      const url = String(input);
      const payload = url.includes("/api/get") ? body : [body];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await openPanel();
      check(await selectWidget("lyric") === "lyric", "the lyric widget is reachable through the stack");
      let now = sample();
      check(now.active === "lyric", `lyric widget is active, got ${now.active}`);

      await emit("media-state", TRACK);
      // Native polls must not cancel a slow LRCLIB request for the same song.
      for (let tick = 0; tick < 10; tick += 1) {
        await wait(100);
        await emit("media-state", { ...TRACK, positionMs: 61_000 + tick * 100 });
      }
      now = sample();
      check(calls === 1 && aborts === 0, `position polls keep one request alive, calls=${calls} aborts=${aborts}`);
      const rows = now.lyrics.map((row) => row.text);
      check(rows.includes("Akhir lagu"), `the row follows the 61s position, got ${JSON.stringify(rows)}`);
      check(
        now.lyrics.some((row) => row.current && row.text === "Akhir lagu"),
        "the line being sung is the current one",
      );
      check(rows.includes("Tengah lagu"), "the line just sung stays as context");

      await emit("media-state", { ...TRACK, positionMs: 5_000 });
      await wait(200);
      now = sample();
      check(
        now.lyrics.some((row) => row.current && row.text === "Awal lagu"),
        `a new position moves the current line, got ${JSON.stringify(now.lyrics)}`,
      );

      // No artist means no service call, and the widget says so plainly.
      await emit("media-state", { ...TRACK, title: "", artist: "", album: "" });
      await wait(200);
      now = sample();
      check(
        now.lyrics.some((row) => row.text === "Lirik belum tersedia"),
        `an unusable track says so, got ${JSON.stringify(now.lyrics)}`,
      );

      // Returning to the same song after empty metadata must restore the sheet.
      await emit("media-state", TRACK);
      await wait(200);
      check(sample().lyrics.some((row) => row.current && row.text === "Akhir lagu"), "lyrics recover after temporarily missing metadata");

      // A previous song may finish late even if the transport ignores abort.
      window.fetch = async (input) => {
        const old = String(input).includes("Lagu%20Lama");
        await wait(old ? 800 : 100);
        return new Response(JSON.stringify({ ...body, syncedLyrics: `[00:00.00]${old ? "Lirik lama" : "Lirik baru"}` }), { status: 200 });
      };
      await emit("media-state", { ...TRACK, title: "Lagu Lama" });
      await wait(100);
      await emit("media-state", { ...TRACK, title: "Lagu Baru" });
      await wait(1000);
      check(sample().lyrics.some((row) => row.current && row.text === "Lirik baru"), "a late answer from the old song cannot overwrite the new one");
    } finally {
      window.fetch = original;
    }
  }

  if (scenario === "lyrics-layout" || scenario === "lyrics-layout-showcase") {
    const original = window.fetch;
    const lines = [
      "Di antara malam yang tenang kita menunggu cahaya",
      "Kita berjalan perlahan menunggu datangnya cahaya pagi",
      "Sampai semua cerita kembali menemukan tempatnya",
    ];
    window.fetch = async () => new Response(JSON.stringify({
      syncedLyrics: `[00:00.00]${lines[0]}\n[00:30.00]${lines[1]}\n[01:00.00]${lines[2]}`,
      duration: 180,
    }), { status: 200 });
    const contains = (outer, inner) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
      && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    try {
      await openPanel();
      check(await selectWidget("lyric") === "lyric", "the lyric widget is reachable through the stack");
      const track = { ...TRACK, title: "Layout lirik panjang", positionMs: 35_000 };
      await emit("media-state", track);
      await wait(400);
      const card = activeCard();
      const bounds = card.getBoundingClientRect();
      const lyric = card.querySelector(".notch-lyrics");
      const slots = [...lyric.querySelectorAll(".notch-lyric-slot")];
      check(slots.length === 3, "all three lyric slots are reserved");
      check(Math.abs(bounds.width - 252) < 1 && Math.abs(bounds.height - 148) < 1, "the compact lyric card stays 252x148");
      check(slots.every((slot) => contains(bounds, slot.getBoundingClientRect())), "all lyric slots fit inside the card");
      const current = lyric.querySelector('[data-current="true"]');
      check(current.textContent === lines[1], "the full active lyric text is retained");
      check(getComputedStyle(current).fontSize === "13px", "the active lyric uses the compact 13px type scale");
      check(current.clientHeight > 18 && current.clientHeight <= 36, `the long active lyric wraps to two lines, height=${current.clientHeight}`);
      check(current.scrollHeight <= current.clientHeight + 1, "the two-line lyric is not clipped");
      const slotHeights = slots.map((slot) => slot.getBoundingClientRect().height);
      for (const positionMs of [65_000, 1_000, 35_000]) {
        await emit("media-state", { ...track, positionMs });
        for (let frame = 0; frame < 5; frame += 1) {
          await wait(40);
          check(slots.every((slot, i) => Math.abs(slot.getBoundingClientRect().height - slotHeights[i]) < 1), "entering/exiting lyrics keep slot heights stable");
          check(contains(bounds, lyric.getBoundingClientRect()), "lyric animation stays within the fixed card");
        }
      }
      if (scenario === "lyrics-layout") {
        // The lyric widget is deliberately not pinnable; the column is for
        // Calendar, Pomodoro and Weather only.
        contextMenu(activeCard());
        await wait(180);
        check(sample().menu === "Tidak bisa di-pin" && sample().menuDisabled, `lyric is not pinnable, got "${sample().menu}"`);
        press(window, "Escape");
        await wait(180);

        await selectWidget("calendar");
        await pinActive();
        await selectWidget("pomodoro");
        await pinActive();
        const pins = pinnedCards();
        check(pins.length === 2, "two widgets share the column");
        check(pins.every((pin) => {
          const rect = pin.getBoundingClientRect();
          return rect.width >= 96 && rect.height >= 60;
        }), "each pinned card keeps a readable body");
        check(Math.abs(pins[0].getBoundingClientRect().height + pins[1].getBoundingClientRect().height + 8 - 148) < 3, "two pins and the gap fill the 148px column");
      }
    } finally {
      window.fetch = original;
    }
  }

  if (scenario === "lyrics-timeout") {
    const original = window.fetch;
    window.fetch = (_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    try {
      await openPanel();
      check(await selectWidget("lyric") === "lyric", "the lyric widget is reachable through the stack");
      await emit("media-state", { ...TRACK, title: "Timeout probe" });
      await wait(7300);
      check(sample().lyrics.some((row) => row.text === "Lirik tidak dapat dimuat"), "a timed-out request leaves loading and reports failure");
    } finally {
      window.fetch = original;
    }
  }

  if (scenario === "stack") {
    await openPanel();
    const before = sample();
    check(before.active === "quicksettings", `quick settings is active first, got ${before.active}`);

    wheel(stackEl(), 120);
    await wait(140);
    wheel(stackEl(), 120);
    let now = sample();
    check(now.active === "sysmon", `the first touchpad input is immediate, got ${now.active}`);
    check(
      now.slots === "quicksettings:previous,sysmon:active,calendar:next,pomodoro:further,lyric:further,weather:further",
      `slot order after one step, got ${now.slots}`,
    );
    const inactive = notch().querySelector('.notch-stack-card[data-slot="next"]');
    check(getComputedStyle(inactive).pointerEvents === "none", "only the active card is interactive");

    // A long decaying touchpad tail must not navigate after a cooldown, and
    // the tiny direction bounce at its end is not a new swipe either.
    for (const delta of [80, 40, 20, 10, 4, 1, 0.5, -0.3]) {
      await wait(60);
      wheel(stackEl(), delta);
    }
    check(sample().active === "sysmon", "a long momentum tail does not skip more widgets");
    // Renewed finger pressure is accepted before the old stream falls quiet.
    for (const delta of [8, 18]) {
      await wait(30);
      wheel(stackEl(), delta);
    }
    await wait(500);
    now = sample();
    check(now.active === "calendar", `a fresh push during momentum advances once, got ${now.active}`);

    stackEl().focus();
    press(stackEl(), "ArrowDown");
    await wait(500);
    now = sample();
    check(now.active === "pomodoro", `ArrowDown advances, got ${now.active}`);
    press(stackEl(), "ArrowUp");
    await wait(500);
    now = sample();
    check(now.active === "calendar", `ArrowUp goes back, got ${now.active}`);
    check(now.scrollTop === 0 && before.scrollTop === 0, "the stack wheel never scrolls the page");
    check(now.width === 640, `the stack keeps the 640 shape, got ${now.width}`);
  }

  if (scenario === "stack-scroll") {
    await openPanel();
    await selectWidget("calendar");
    // A scrollable child should keep wheel input until its directional edge,
    // just like the WPF widget host's nested ScrollViewer handling.
    const list = document.createElement("div");
    list.style.cssText = "position:absolute;top:40px;left:10px;height:40px;width:160px;overflow-y:auto";
    const content = document.createElement("div");
    content.style.height = "160px";
    content.textContent = "Daftar uji";
    list.append(content);
    activeCard().append(list);
    const send = (deltaY, extra = {}) => {
      const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
      content.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      list.scrollTop = 40;
      check(!send(120), "the nested list handles downward input while it has room");
      check(!send(-120), "the nested list handles upward input while it has room");
      check(sample().active === "calendar", "scrolling within the list does not rotate widgets");
      list.scrollTop = list.scrollHeight;
      check(!send(120, { ctrlKey: true }), "zoom gestures are not consumed");
      check(!send(10, { deltaX: 100 }), "horizontal gestures are not consumed");
      check(send(120), "at the bottom the carousel consumes wheel input");
      await wait(500);
      check(sample().active === "pomodoro", "reaching the list edge hands input to the next widget");
    } finally {
      list.remove();
    }
  }

  if (scenario === "pin") {
    await openPanel();
    await selectWidget("calendar");
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
    check(Math.abs(now.width - 752) < 4, `pinning widens to 752, got ${now.width.toFixed(1)}`);
    check(Math.abs(now.height - 200) < 3, `height stays 200, got ${now.height.toFixed(1)}`);
    check(now.pinHeights.length === 1 && Math.abs(now.pinHeights[0] - 148) < 2, `one pin fills the column, got ${now.pinHeights}`);
    check(notch().querySelectorAll(".notch-stack-card").length === 5, "pinned widget leaves the stack");
    check(now.open, "pinning does not close the panel");
    check(
      window.__notchCommands.filter((entry) => entry.command === "show_notch_menu").length === exitMenus,
      "the widget menu does not trigger the native notch menu",
    );

    clickTab("tray");
    await wait(700);
    now = sample();
    check(Math.abs(now.width - 640) < 4, `Tray returns to 640, got ${now.width.toFixed(1)}`);
    clickTab("nook");
    await wait(900);
    now = sample();
    check(Math.abs(now.width - 752) < 4, `back on Nook widens again, got ${now.width.toFixed(1)}`);
    check(now.pinned.join() === "calendar", "the pin survives a tab switch");

    contextMenu(pinnedCards()[0]);
    await wait(160);
    now = sample();
    check(now.menu === "Unpin widget", `pinned menu offers Unpin, got "${now.menu}"`);
    clickMenu();
    await wait(900);
    now = sample();
    check(now.pinned.length === 0, "unpin empties the column");
    check(Math.abs(now.width - 640) < 4, `unpinning narrows to 640, got ${now.width.toFixed(1)}`);
    check(notch().querySelectorAll(".notch-stack-card").length === 6, "the widget returns to the stack");
    check(now.open, "unpinning does not close the panel");
  }

  if (scenario === "pinlimit") {
    await openPanel();
    await selectWidget("calendar");
    await pinActive();
    await selectWidget("pomodoro");
    await pinActive();
    let now = sample();
    check(now.pinned.join() === "calendar,pomodoro", `two pins in order, got ${now.pinned}`);
    check(Math.abs(now.width - 752) < 4, `still 752 with two pins, got ${now.width.toFixed(1)}`);
    check(now.pinHeights.length === 2, "two pinned cards");
    check(Math.abs(now.pinHeights[0] - now.pinHeights[1]) < 2, `split heights equal, got ${now.pinHeights}`);
    check(Math.abs(now.pinHeights[0] + now.pinHeights[1] + 8 - 148) < 3, `two cards and the gap fill 148, got ${now.pinHeights}`);

    // A third pin must be refused: right-click a pinnable stack card.
    await selectWidget("weather");
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
    check(await selectWidget("pomodoro") === "pomodoro", "pomodoro reached through the stack");
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
    await emit("media-state", TRACK);
    await wait(300);
    await selectWidget("calendar");
    await pinActive();
    await selectWidget("pomodoro");
    let now = sample();
    check(now.pinned.join() === "calendar", "pin exists before closing");
    await emit("notch-click-outside", null);
    await wait(700);
    now = sample();
    check(!now.open, "outside click closes the wide panel");
    check(Math.abs(now.width - 200) < 3 && Math.abs(now.height - 34) < 3, `collapses to 200x34, got ${now.width.toFixed(1)}x${now.height.toFixed(1)}`);
    check(now.clockMedia && now.clockBars === 3, "the closed bar shows the playing badge");
    await emit("media-state", { ...TRACK, playing: false });
    await wait(250);
    now = sample();
    check(!now.clockMedia, "a paused player removes the badge");
    await emit("media-state", TRACK);
    await wait(250);
    await emit("notch-press", null);
    await wait(900);
    now = sample();
    check(now.open, "reopens");
    check(!now.clockMedia, "the badge belongs to the closed bar, not the panel");
    check(Math.abs(now.width - 752) < 4, `retained pins reopen directly at 752, got ${now.width.toFixed(1)}`);
    check(now.pinned.join() === "calendar", "pins survive the panel closing");
    check(now.active === "pomodoro", "the last active widget survives collapse");
  }

  if (scenario === "retained") {
    await openPanel();
    await selectWidget("calendar");
    await pinActive();
    await selectWidget("pomodoro");
    await pinActive();
    await drag(pinnedCards()[0], 60);
    const before = sample();
    clickTab("sharing");
    await wait(700);
    await emit("notch-click-outside", null);
    await wait(700);
    check(!notch().querySelector(".notch-panel"), "closed views are unmounted, not left interactive");
    await openPanel();
    check(notch().querySelector('[role="tab"][aria-selected="true"]')?.dataset.tabId === "sharing", "reopens the last tab, not Nook");
    check(Math.abs(sample().width - 640) < 1, "a retained non-Nook tab uses the narrow silhouette");
    clickTab("nook");
    await wait(900);
    const after = sample();
    check(after.pinned.join() === before.pinned.join(), "pin order survives collapse on another tab");
    check(after.active === before.active, "widget selection survives collapse on another tab");
    const polling = window.__notchCommands.filter((entry) => entry.command === "media_polling");
    check(polling.some((entry) => entry.args.active === false), "media backs off while Nook is not visible");
    check(polling.at(-1)?.args.active === true, "returning to Nook restores fast media polling");
  }

  if (scenario === "timer-modes") {
    await openPanel();
    check(await selectWidget("pomodoro") === "pomodoro", "pomodoro reached through the stack");
    const timerCard = () => notch().querySelector('.notch-stack-card[data-widget="pomodoro"]');
    const mode = () => timerCard().querySelector(".notch-pomodoro-mode").click();
    mode();
    await wait(200);
    check(sample().timerMode === "5 mnt" && sample().stackTime === "5:00", "short break is five minutes");
    check(sample().timerModeLabel === "Istirahat singkat", "mode has an Indonesian label");
    timerCard().querySelector(".notch-pill-light").click();
    await wait(1200);
    mode();
    await wait(200);
    check(sample().timerMode === "15 mnt" && sample().stackTime === "15:00" && sample().stackStart === "Mulai", "changing mode stops and resets the timer like WPF");
    mode();
    await wait(200);
    check(sample().timerMode === "25 mnt" && sample().stackTime === "25:00", "mode wraps back to focus");
    mode();
    await wait(200);
    timerCard().querySelector(".notch-pill-light").click();
    await wait(1300);
    const before = seconds(sample().stackTime);
    await emit("media-state", TRACK);
    await emit("notch-click-outside", null);
    await wait(1800);
    check(sample().clockTimerPhase === "running" && !sample().clockMedia, "collapsed Pomodoro takes priority over media");
    check(sample().clockCentered && sample().clockStatusFits, "running timer leaves the clock centred and fits the unchanged bar");
    check(seconds(sample().clockTimerText) < before, "timer keeps running while collapsed");
    await openPanel();
    check(sample().active === "pomodoro" && sample().timerMode === "5 mnt", "selected widget and mode survive collapse");
    check(seconds(sample().stackTime) < before && sample().stackStart === "Jeda", "running deadline survives reopening");
    timerCard().querySelector(".notch-pill-light").click();
    await wait(150);
    const paused = sample().stackTime;
    await emit("notch-click-outside", null);
    await wait(1300);
    check(sample().clockTimerPhase === "paused" && sample().clockTimerText === paused, "paused timer stays frozen in the closed bar");
    check(sample().clockCentered && sample().clockStatusFits, "pause indicator does not move or overlap the clock");
    await openPanel();
    check(sample().stackTime === paused && sample().stackStart === "Mulai", "paused state survives reopening");
    timerCard().querySelector(".notch-pill-ghost").click();
    await wait(200);
    check(sample().stackTime === "5:00", "reset uses the selected duration, not always 25 minutes");
    const modeButton = timerCard().querySelector(".notch-pomodoro-mode");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    modeButton.dispatchEvent(enter);
    check(!enter.defaultPrevented, "the notch shell does not swallow keyboard activation of a child control");
    modeButton.focus();
    press(modeButton, "ArrowDown");
    await wait(450);
    check(sample().active === "lyric" && document.activeElement === stackEl(), "keyboard widget navigation returns focus to the stack instead of a newly inert control");
  }

  if (scenario === "timer-finished") {
    const realNow = Date.now;
    let offset = 0;
    try {
      Date.now = () => realNow() + offset;
      await openPanel();
      check(await selectWidget("pomodoro") === "pomodoro", "pomodoro reached through the stack");
      const timerCard = () => notch().querySelector('.notch-stack-card[data-widget="pomodoro"]');
      timerCard().querySelector(".notch-pomodoro-mode").click();
      await wait(150);
      timerCard().querySelector(".notch-pill-light").click();
      await emit("media-state", TRACK);
      await emit("notch-click-outside", null);
      await wait(700);
      offset = 301_000;
      document.dispatchEvent(new Event("visibilitychange"));
      await wait(450);
      check(sample().clockTimerPhase === "finished" && sample().clockTimerText === "Selesai", "completion shows a Selesai confirmation while collapsed");
      check(!sample().clockMedia, "completion feedback outranks media");
      check(sample().clockCentered && sample().clockStatusFits, "finished confirmation fits without moving the clock");
      offset += 3100;
      document.dispatchEvent(new Event("visibilitychange"));
      await wait(450);
      check(!sample().clockTimerPhase && sample().clockMedia, "after three seconds the bar returns to media, not a permanent zero timer");
      await openPanel();
      check(sample().stackTime === "0:00" && sample().stackStart === "Ulangi", "finished state is retained");
      timerCard().querySelector(".notch-pill-light").click();
      await wait(250);
      check(sample().stackTime === "5:00" && sample().stackStart === "Jeda", "restart begins a full session in the selected mode");
    } finally {
      Date.now = realNow;
    }
  }

  if (scenario === "island") {
    await wait(400);
    check(sample().clockCentered, "idle clock is centred horizontally and vertically");
    await emit("media-state", TRACK);
    await wait(400);
    check(sample().clockCentered && sample().clockStatusFits, "media badge leaves the clock anchored to the same centre");
    check(sample().clockBars === 3, "the minimal playing badge still animates");
    check(getComputedStyle(notch().querySelector(".notch-clock-bar")).animationName === "notch-clock-bar", "playing animation remains enabled");
    await emit("media-state", { ...TRACK, playing: false });
    await wait(400);
    check(sample().clockCentered && !sample().clockMedia, "removing the badge does not shift the clock");
    check(sample().width === 200 && sample().height === 34, "Dynamic Island polish does not shrink the collapsed notch");
  }

  if (scenario === "seek-close") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(250);
    const track = notch().querySelector(".notch-media-track");
    const rect = track.getBoundingClientRect();
    pointer(track, "pointerdown", rect.left + rect.width * 0.5);
    await wait(150);
    check(sample().current === "1:30", "seek preview is visible before collapse");
    await emit("notch-click-outside", null);
    await wait(700);
    await emit("media-state", { ...TRACK, positionMs: 63_000 });
    await openPanel();
    check(sample().current === "1:03", "reopening restores real playback, not an abandoned drag preview");
    check(!window.__notchCommands.some((entry) => entry.command === "media_seek"), "closing a drag does not submit an unintended seek");
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
    await selectWidget("calendar");
    await pinActive();
    await wait(400);
    sample();
  }

  if (scenario === "showcase2") {
    await openPanel();
    check(await selectWidget("pomodoro") === "pomodoro", "pomodoro reached through the stack");
    notch().querySelector('.notch-stack-card[data-widget="pomodoro"] .notch-pill-light').click();
    await wait(1200);
    await pinActive();
    await selectWidget("calendar");
    await pinActive();
    await wait(700);
    sample();
  }

  if (scenario === "showcase3") {
    await openPanel();
    await emit("media-state", TRACK);
    await wait(1300);
    await selectWidget("calendar");
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
