import { expect, test } from "bun:test";
import {
  appName,
  keepArtwork,
  mediaCaption,
  mediaPercent,
  mediaTime,
  mergeMediaState,
  nextRepeat,
  seekRatio,
  seekSettled,
  seekTarget,
} from "../src/media";
import type { MediaState } from "../src/media";
import {
  calendarTitle,
  compactMonth,
  MAX_PINNED,
  POMODORO_SECONDS,
  pinVerdict,
  pinWidget,
  pomodoroClock,
  pomodoroFraction,
  pomodoroPhase,
  rotate,
  stackOffset,
  stackSlot,
  stackWidgets,
  swapPinned,
  unpinWidget,
  weekOf,
  weekdayLong,
  WidgetWheelNavigator,
} from "../src/nook";

test("a touchpad swipe advances immediately and consumes a long decaying tail", () => {
  const wheel = new WidgetWheelNavigator();
  expect(wheel.step(120, 0, 0)).toBe(1);
  let magnitude = 120;
  for (let time = 16; time < 2000; time += 16) {
    magnitude *= 0.95;
    expect(wheel.step(magnitude, 0, time)).toBe(0);
  }
  expect(wheel.step(8, 0, 2300)).toBe(1);
});

test("a fresh push during momentum responds without waiting for silence", () => {
  const wheel = new WidgetWheelNavigator();
  const trace = [40, 80, 60, 40, 24, 14, 8, 4, 2];
  expect(trace.map((delta, i) => wheel.step(delta, 0, i * 30))).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(wheel.step(8, 0, 270)).toBe(0);
  expect(wheel.step(18, 0, 300)).toBe(1);
  expect(wheel.step(30, 0, 330)).toBe(0);
  expect(wheel.step(20, 0, 360)).toBe(0);
});

test("tiny reversed tails are ignored but a deliberate opposite swipe responds", () => {
  const wheel = new WidgetWheelNavigator();
  expect(wheel.step(40, 0, 0)).toBe(1);
  for (const [time, delta] of [[40, 24], [80, 12], [120, 6], [160, 2], [200, -0.5], [240, -1]]) {
    expect(wheel.step(delta, 0, time)).toBe(0);
  }
  expect(wheel.step(-20, 0, 270)).toBe(-1);
  expect(wheel.step(-12, 0, 300)).toBe(0);
});

test("an isolated noisy momentum spike does not look like a fresh push", () => {
  const wheel = new WidgetWheelNavigator();
  const trace = [60, 40, 25, 12, 6, 3, 10, 4, 3, 2];
  expect(trace.map((delta, i) => wheel.step(delta, 0, i * 50))).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("a long flat touchpad stream cannot advance on cooldown alone", () => {
  const wheel = new WidgetWheelNavigator();
  expect(wheel.step(8, 0, 0)).toBe(1);
  for (let time = 80; time <= 1600; time += 80) expect(wheel.step(8, 0, time)).toBe(0);
});

test("line and page wheel input retains the WPF throttle", () => {
  const wheel = new WidgetWheelNavigator();
  expect(wheel.step(3, 0, 0, 1)).toBe(1);
  expect(wheel.step(3, 0, 140, 1)).toBe(0);
  expect(wheel.step(3, 0, 350, 1)).toBe(1);
  expect(wheel.step(-1, 0, 700, 2)).toBe(-1);
});

test("small deltas respond immediately without an accumulation threshold", () => {
  expect(new WidgetWheelNavigator().step(0.5, 0, 0)).toBe(1);
  expect(new WidgetWheelNavigator().step(-0.5, 0, 0)).toBe(-1);
});

test("horizontal input and invalid deltas cannot rotate the stack", () => {
  const wheel = new WidgetWheelNavigator();
  expect(wheel.step(10, 100, 0)).toBe(0);
  expect(wheel.step(Number.NaN, 0, 30)).toBe(0);
  expect(wheel.step(Number.POSITIVE_INFINITY, 0, 60)).toBe(0);
  expect(wheel.step(0, 0, 90)).toBe(0);
  expect(wheel.step(-24, 0, 120)).toBe(-1);
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

test("mediaTime formats minutes and the rare hour-long track", () => {
  expect(mediaTime(0)).toBe("0:00");
  expect(mediaTime(61_000)).toBe("1:01");
  expect(mediaTime(3_723_000)).toBe("1:02:03");
  expect(mediaTime(Number.NaN)).toBe("0:00");
});

test("mediaPercent clamps and survives an unknown length", () => {
  expect(mediaPercent(30_000, 60_000)).toBe(50);
  expect(mediaPercent(90_000, 60_000)).toBe(100);
  expect(mediaPercent(-5, 60_000)).toBe(0);
  expect(mediaPercent(1_000, 0)).toBe(0);
});

test("keepArtwork holds the cover while the track is unchanged", () => {
  const first = { title: "A", artist: "B", album: "C", source: "Spotify.exe", thumbnail: "data:image/png;base64,xx" };
  const sameTrack = { title: "A", artist: "B", album: "C", source: "Spotify.exe" };
  const newTrack = { title: "D", artist: "E", album: "F", source: "Spotify.exe" };
  // Same title and artist, different album: a different recording.
  const otherAlbum = { title: "A", artist: "B", album: "D", source: "Spotify.exe" };
  // Same metadata from another player: another session, another sleeve.
  const otherSource = { title: "A", artist: "B", album: "C", source: "MusicBee.exe" };

  expect(keepArtwork(first, sameTrack)).toEqual({ ...sameTrack, thumbnail: first.thumbnail });
  expect(keepArtwork(first, newTrack)).toEqual(newTrack);
  expect(keepArtwork(first, otherAlbum)).toEqual(otherAlbum);
  expect(keepArtwork(first, otherSource)).toEqual(otherSource);
  expect(keepArtwork(first, { ...sameTrack, thumbnail: "data:new" })).toEqual({
    ...sameTrack,
    thumbnail: "data:new",
  });
  expect(keepArtwork(first, null)).toBeNull();
  expect(keepArtwork(null, sameTrack)).toEqual(sameTrack);
});

test("mergeMediaState latches transient zero timeline dropouts for the same song", () => {
  const full = {
    title: "Malam",
    artist: "Band",
    album: "Demo",
    playing: true,
    positionMs: 45_000,
    durationMs: 180_000,
    hasTimeline: true,
    canPrevious: true,
    canNext: true,
    canToggle: true,
    canSeek: true,
    shuffle: false,
    shuffleSupported: true,
    repeat: "none" as const,
    repeatSupported: true,
    source: "Spotify.exe",
    thumbnail: "data:art",
  };
  const dropped = {
    ...full,
    positionMs: 0,
    durationMs: 0,
    hasTimeline: false,
    canSeek: false,
    thumbnail: undefined,
  };

  const merged = mergeMediaState(full, dropped);
  expect(merged?.durationMs).toBe(180_000);
  expect(merged?.positionMs).toBe(45_000);
  expect(merged?.hasTimeline).toBe(true);
  expect(merged?.canSeek).toBe(true);
  expect(merged?.thumbnail).toBe("data:art");

  // Track change should not latch old duration
  const newTrack = {
    ...dropped,
    title: "Lagu Baru",
    durationMs: 200_000,
  };
  const switched = mergeMediaState(full, newTrack);
  expect(switched?.title).toBe("Lagu Baru");
  expect(switched?.durationMs).toBe(200_000);
  expect(switched?.thumbnail).toBeUndefined();
});

test("mediaCaption says there is no media instead of inventing a song", () => {
  expect(mediaCaption(null)).toEqual({ title: "Tidak ada media", artist: "", album: "" });

  const track = {
    title: "  ",
    artist: "",
    album: "Album",
    playing: false,
    positionMs: 0,
    durationMs: 0,
    hasTimeline: false,
    canPrevious: false,
    canNext: false,
    canToggle: false,
    canSeek: false,
    shuffle: false,
    shuffleSupported: false,
    repeat: "none",
    repeatSupported: false,
    source: "Spotify.exe",
  } satisfies NonNullable<MediaState>;
  expect(mediaCaption(track)).toEqual({ title: "Album", artist: "Spotify", album: "" });
});

test("an app name is readable from an executable or a packaged-app id", () => {
  expect(appName("Spotify.exe")).toBe("Spotify");
  expect(appName("C:\\Program Files\\Mozilla Firefox\\firefox.exe")).toBe("firefox");
  expect(appName("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")).toBe("Spotify");
  expect(appName("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic")).toBe("ZuneMusic");
  expect(appName("")).toBe("");
});

test("a seek target follows the pointer and stays inside the track", () => {
  expect(seekTarget(0.25, 180_000)).toBe(45_000);
  expect(seekTarget(0.75, 180_000)).toBe(135_000);
  expect(seekTarget(-1, 180_000)).toBe(0);
  expect(seekTarget(2, 180_000)).toBe(180_000);
  // A live stream has no length to seek inside.
  expect(seekTarget(0.5, 0)).toBe(0);
  expect(seekTarget(Number.NaN, 180_000)).toBe(0);
});

test("the pointer position is a clamped ratio of the bar", () => {
  expect(seekRatio(150, 100, 200)).toBe(0.25);
  expect(seekRatio(90, 100, 200)).toBe(0);
  expect(seekRatio(400, 100, 200)).toBe(1);
  expect(seekRatio(150, 100, 0)).toBe(0);
});

test("a seek settles only when the player came close to the target", () => {
  expect(seekSettled(60_000, 60_400)).toBe(true);
  expect(seekSettled(60_000, 61_400)).toBe(true);
  expect(seekSettled(60_000, 63_000)).toBe(false);
});

test("repeat cycles off, all, one", () => {
  expect(nextRepeat("none")).toBe("list");
  expect(nextRepeat("list")).toBe("track");
  expect(nextRepeat("track")).toBe("none");
});

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

test("the stack keeps its order and drops pinned widgets", () => {
  expect(stackWidgets([])).toEqual([
    "quicksettings",
    "sysmon",
    "calendar",
    "pomodoro",
    "lyric",
    "weather",
  ]);
  expect(stackWidgets(["pomodoro", "weather"])).toEqual([
    "quicksettings",
    "sysmon",
    "calendar",
    "lyric",
  ]);
});

test("rotation wraps in both directions", () => {
  const list = stackWidgets([]);
  expect(rotate(list, "quicksettings", 1)).toBe("sysmon");
  expect(rotate(list, "weather", 1)).toBe("quicksettings");
  expect(rotate(list, "quicksettings", -1)).toBe("weather");
  expect(rotate(list, "sysmon", -1)).toBe("quicksettings");
});

test("a card's slot follows its distance from the active one", () => {
  const list = stackWidgets([]);
  expect(stackSlot(stackOffset(list, "quicksettings", "quicksettings"), list.length)).toBe("active");
  expect(stackSlot(stackOffset(list, "quicksettings", "sysmon"), list.length)).toBe("next");
  expect(stackSlot(stackOffset(list, "quicksettings", "calendar"), list.length)).toBe("further");
  expect(stackSlot(stackOffset(list, "quicksettings", "weather"), list.length)).toBe("previous");
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test("pinning appends, refuses duplicates, respects pinnable whitelist, and stops at two", () => {
  expect(pinVerdict([], "quicksettings")).toBe("not-pinnable");
  expect(pinVerdict([], "sysmon")).toBe("not-pinnable");
  expect(pinVerdict([], "lyric")).toBe("not-pinnable");
  expect(pinWidget([], "quicksettings")).toEqual([]);
  expect(pinWidget([], "sysmon")).toEqual([]);
  expect(pinWidget([], "lyric")).toEqual([]);

  expect(pinVerdict([], "calendar")).toBe("pin");
  expect(pinWidget([], "calendar")).toEqual(["calendar"]);
  expect(pinWidget(["calendar"], "pomodoro")).toEqual(["calendar", "pomodoro"]);
  expect(pinWidget(["calendar"], "calendar")).toEqual(["calendar"]);
  expect(pinVerdict(["calendar", "pomodoro"], "weather")).toBe("full");
  expect(pinWidget(["calendar", "pomodoro"], "weather")).toEqual(["calendar", "pomodoro"]);
  expect(MAX_PINNED).toBe(2);
});

test("unpinning removes the widget and keeps the rest in order", () => {
  expect(pinVerdict(["calendar", "pomodoro"], "calendar")).toBe("unpin");
  expect(unpinWidget(["calendar", "pomodoro"], "calendar")).toEqual(["pomodoro"]);
  expect(unpinWidget(["calendar"], "weather")).toEqual(["calendar"]);
});

test("dragging swaps two pinned neighbours and ignores bad indices", () => {
  expect(swapPinned(["calendar", "pomodoro"], 0, 1)).toEqual(["pomodoro", "calendar"]);
  expect(swapPinned(["calendar", "pomodoro"], 1, 0)).toEqual(["pomodoro", "calendar"]);
  expect(swapPinned(["calendar"], 0, 0)).toEqual(["calendar"]);
  expect(swapPinned(["calendar"], 0, 3)).toEqual(["calendar"]);
  expect(swapPinned(["calendar"], -1, 0)).toEqual(["calendar"]);
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

test("the week starts on Monday and marks today", () => {
  // Friday 23 October 2026: the strip runs 19..25.
  const week = weekOf(new Date(2026, 9, 23, 15, 30));
  expect(week.map((day) => day.weekday)).toEqual(["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]);
  expect(week.map((day) => day.day)).toEqual([19, 20, 21, 22, 23, 24, 25]);
  expect(week.filter((day) => day.today).map((day) => day.weekday)).toEqual(["Jum"]);
  expect(calendarTitle(new Date(2026, 9, 23))).toBe("Oktober 2026");
  expect(compactMonth(new Date(2026, 9, 23))).toBe("Okt");
  expect(weekdayLong(new Date(2026, 9, 23))).toBe("Jumat");
});

test("a Monday week does not reach into the previous month", () => {
  const week = weekOf(new Date(2026, 9, 19));
  expect(week[0].day).toBe(19);
  expect(week[0].today).toBe(true);
});

// ---------------------------------------------------------------------------
// Pomodoro
// ---------------------------------------------------------------------------

test("the Pomodoro clock, fraction, and status labels", () => {
  expect(POMODORO_SECONDS).toBe(1500);
  expect(pomodoroClock(1500)).toBe("25:00");
  expect(pomodoroClock(61)).toBe("1:01");
  expect(pomodoroClock(0)).toBe("0:00");
  expect(pomodoroFraction(1500)).toBe(1);
  expect(pomodoroFraction(750)).toBe(0.5);
  expect(pomodoroFraction(0)).toBe(0);
  expect(pomodoroFraction(150, 300)).toBe(0.5);
  expect(pomodoroFraction(450, 900)).toBe(0.5);
  expect(pomodoroFraction(300, 300)).toBe(1);
  expect(pomodoroFraction(1, 0)).toBe(0);
  expect(pomodoroPhase(true, false)).toBe("running");
  expect(pomodoroPhase(false, false)).toBe("paused");
  expect(pomodoroPhase(false, true)).toBe("finished");
});
