import { expect, test } from "bun:test";
import { nextPlayheadAnchor, playheadAt } from "../src/media";
import type { MediaState, PlayheadAnchor } from "../src/media";

// ---------------------------------------------------------------------------
// The clock shared by the progress bar and the lyrics
// ---------------------------------------------------------------------------

type Track = NonNullable<MediaState>;

function track(overrides: Partial<Track> = {}): Track {
  return {
    title: "Lagu",
    artist: "Penyanyi",
    album: "Album",
    playing: true,
    positionMs: 0,
    durationMs: 180_000,
    hasTimeline: true,
    canPrevious: true,
    canNext: true,
    canToggle: true,
    canSeek: true,
    shuffle: false,
    shuffleSupported: true,
    repeat: "none",
    repeatSupported: true,
    source: "Spotify.exe",
    playbackRate: 1,
    ...overrides,
  };
}

const anchorAt = (baseMs: number, at = 1_000, overrides: Partial<PlayheadAnchor> = {}): PlayheadAnchor => ({
  baseMs,
  at,
  playing: true,
  durationMs: 180_000,
  trackKey: "Lagu\nPenyanyi\nAlbum",
  playbackRate: 1,
  ...overrides,
});

test("the newest source position wins over the locally projected one", () => {
  // 1 s of local projection must not be kept when the player says 30.4 s.
  const next = nextPlayheadAnchor(anchorAt(30_000), track({ positionMs: 30_400 }), 2_000);
  expect(next.baseMs).toBe(30_400);
  expect(next.at).toBe(2_000);
  expect(playheadAt(next, 2_000)).toBe(30_400);
});

test("a small backward correction is accepted instead of smoothed away", () => {
  // The old code ignored anything under 1.5 s, which is exactly the drift that
  // made the words sit behind the voice.
  const next = nextPlayheadAnchor(anchorAt(30_000), track({ positionMs: 29_700 }), 2_000);
  expect(next.baseMs).toBe(29_700);
  expect(playheadAt(next, 2_000)).toBe(29_700);
});

test("a seek made in the source player lands immediately", () => {
  const next = nextPlayheadAnchor(anchorAt(30_000), track({ positionMs: 90_000 }), 2_000);
  expect(next.baseMs).toBe(90_000);
  expect(playheadAt(next, 2_000)).toBe(90_000);
});

test("a stale zero does not rewind a playing track", () => {
  const next = nextPlayheadAnchor(anchorAt(30_000), track({ positionMs: 0 }), 2_000);
  expect(next.baseMs).toBe(30_000);
  // The old measurement point is kept, so the elapsed second is not lost.
  expect(next.at).toBe(1_000);
  expect(playheadAt(next, 2_000)).toBe(31_000);
});

test("a real pause keeps the position frozen", () => {
  const next = nextPlayheadAnchor(anchorAt(30_000), track({ playing: false, positionMs: 30_250 }), 2_000);
  expect(playheadAt(next, 90_000)).toBe(30_250);
});

test("a new track may start at zero even after a long previous one", () => {
  const next = nextPlayheadAnchor(
    anchorAt(30_000),
    track({ title: "Lain", positionMs: 0, durationMs: 200_000 }),
    2_000,
  );
  expect(next.baseMs).toBe(0);
  expect(next.at).toBe(2_000);
  expect(next.trackKey).toBe("Lain\nPenyanyi\nAlbum");
});

test("the projection follows the playback rate", () => {
  const anchor = anchorAt(10_000, 1_000, { playbackRate: 1.5 });
  expect(playheadAt(anchor, 3_000)).toBe(13_000);
});

test("the playhead never runs past the reported duration", () => {
  const anchor = anchorAt(179_500, 1_000, { durationMs: 180_000 });
  expect(playheadAt(anchor, 5_000)).toBe(180_000);
});

test("a zero or missing rate falls back to normal speed", () => {
  const zero = nextPlayheadAnchor(anchorAt(0), track({ positionMs: 1_000, playbackRate: 0 }), 2_000);
  expect(zero.playbackRate).toBe(1);
  const missing = nextPlayheadAnchor(anchorAt(0), track({ positionMs: 1_000, playbackRate: undefined }), 2_000);
  expect(missing.playbackRate).toBe(1);
});
