import { expect, test } from "bun:test";
import {
  appName,
  keepArtwork,
  mediaCaption,
  mediaPercent,
  mediaTime,
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
} from "../src/nook";

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
  const first = { title: "A", artist: "B", album: "C", thumbnail: "data:image/png;base64,xx" };
  const sameTrack = { title: "A", artist: "B", album: "C" };
  const newTrack = { title: "D", artist: "E", album: "F" };
  // Same title and artist, different album: a different recording.
  const otherAlbum = { title: "A", artist: "B", album: "D" };

  expect(keepArtwork(first, sameTrack)).toEqual({ ...sameTrack, thumbnail: first.thumbnail });
  expect(keepArtwork(first, newTrack)).toEqual(newTrack);
  expect(keepArtwork(first, otherAlbum)).toEqual(otherAlbum);
  expect(keepArtwork(first, { ...sameTrack, thumbnail: "data:new" })).toEqual({
    ...sameTrack,
    thumbnail: "data:new",
  });
  expect(keepArtwork(first, null)).toBeNull();
  expect(keepArtwork(null, sameTrack)).toEqual(sameTrack);
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
  expect(stackWidgets([])).toEqual(["calendar", "pomodoro", "lyric", "weather"]);
  expect(stackWidgets(["pomodoro", "weather"])).toEqual(["calendar", "lyric"]);
});

test("rotation wraps in both directions", () => {
  const list = stackWidgets([]);
  expect(rotate(list, "calendar", 1)).toBe("pomodoro");
  expect(rotate(list, "weather", 1)).toBe("calendar");
  expect(rotate(list, "calendar", -1)).toBe("weather");
  expect(rotate(list, "lyric", -1)).toBe("pomodoro");
});

test("a card's slot follows its distance from the active one", () => {
  const list = stackWidgets([]);
  expect(stackSlot(stackOffset(list, "calendar", "calendar"), list.length)).toBe("active");
  expect(stackSlot(stackOffset(list, "calendar", "pomodoro"), list.length)).toBe("next");
  expect(stackSlot(stackOffset(list, "calendar", "lyric"), list.length)).toBe("further");
  expect(stackSlot(stackOffset(list, "calendar", "weather"), list.length)).toBe("previous");
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test("pinning appends, refuses duplicates, and stops at two", () => {
  expect(pinVerdict([], "calendar")).toBe("pin");
  expect(pinWidget([], "calendar")).toEqual(["calendar"]);
  expect(pinWidget(["calendar"], "pomodoro")).toEqual(["calendar", "pomodoro"]);
  expect(pinWidget(["calendar"], "calendar")).toEqual(["calendar"]);
  expect(pinVerdict(["calendar", "pomodoro"], "lyric")).toBe("full");
  expect(pinWidget(["calendar", "pomodoro"], "lyric")).toEqual(["calendar", "pomodoro"]);
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
  expect(pomodoroPhase(true, false)).toBe("running");
  expect(pomodoroPhase(false, false)).toBe("paused");
  expect(pomodoroPhase(false, true)).toBe("finished");
});
