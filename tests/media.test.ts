import { expect, test } from "bun:test";
import {
  MAX_SAMPLE_AGE_MS,
  nextPlayheadAnchor,
  playheadAt,
  projectSample,
  trackIdentity,
} from "../src/media";
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
  trackKey: trackIdentity(track()),
  playbackRate: 1,
  sampleStampMs: null,
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
  expect(next.trackKey).toBe(trackIdentity(track({ title: "Lain", positionMs: 0 })));
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

// ---------------------------------------------------------------------------
// When the sample was taken
// ---------------------------------------------------------------------------

test("the flight time of a payload is added exactly once", () => {
  // Native already projected the player's LastUpdatedTime to `sampledAtMs`;
  // the webview only adds the IPC hop after that instant.
  const media = track({ positionMs: 10_000, sampledAtMs: 1_000 });

  expect(projectSample(media, 1_500)).toBe(10_500);
  expect(projectSample({ ...media, playing: false }, 1_500)).toBe(10_000);
  expect(projectSample({ ...media, playbackRate: 2 }, 1_500)).toBe(11_000);
});

test("an absurdly old sample is not projected into the future", () => {
  const media = track({ positionMs: 10_000, sampledAtMs: 1_000 });
  expect(projectSample(media, 1_000 + MAX_SAMPLE_AGE_MS * 5)).toBe(10_000 + MAX_SAMPLE_AGE_MS);
  // A clock that went backwards adds nothing rather than rewinding the bar.
  expect(projectSample(media, 500)).toBe(10_000);
});

test("the anchor adopts the sample's own timestamp", () => {
  const next = nextPlayheadAnchor(
    anchorAt(30_000, 1_000),
    track({ positionMs: 30_000, sampledAtMs: 2_000 }),
    3_000,
    2_500,
  );
  expect(next.baseMs).toBe(30_500);
  expect(next.at).toBe(3_000);
  expect(playheadAt(next, 3_000)).toBe(30_500);
});

// ---------------------------------------------------------------------------
// Publication identity, and the same metadata from two players
// ---------------------------------------------------------------------------

test("the same song from another app is another track", () => {
  const spotify = track();
  const musicBee = track({ source: "MusicBee.exe" });
  expect(trackIdentity(spotify)).not.toBe(trackIdentity(musicBee));

  const next = nextPlayheadAnchor(anchorAt(30_000), { ...musicBee, positionMs: 0 }, 2_000);
  expect(next.baseMs).toBe(0);
  expect(next.at).toBe(2_000);
});

test("a newer publication is real news even when it says zero", () => {
  // A repeat or a seek to the start publishes zero *with* a new stamp; the
  // stale-zero guard must not swallow that.
  const previous = anchorAt(30_000, 1_000, { sampleStampMs: 1_000 });
  const next = nextPlayheadAnchor(
    previous,
    track({ positionMs: 0, timelineUpdatedMs: 1_500 }),
    2_000,
  );
  expect(next.baseMs).toBe(0);
  expect(next.at).toBe(2_000);
  expect(next.sampleStampMs).toBe(1_500);
});

test("an unchanged publication cannot rewind a playing track", () => {
  const previous = anchorAt(30_000, 1_000, { sampleStampMs: 1_000 });
  const next = nextPlayheadAnchor(
    previous,
    track({ positionMs: 0, timelineUpdatedMs: 1_000 }),
    2_000,
  );
  expect(next.baseMs).toBe(30_000);
  expect(next.at).toBe(1_000);
  expect(playheadAt(next, 2_000)).toBe(31_000);
  expect(next.sampleStampMs).toBe(1_000);
});
