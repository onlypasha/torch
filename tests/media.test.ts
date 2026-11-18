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

test.each([undefined, 5000])("a new track starting at zero advances through repeated snapshots (stamp %s)", (stamp) => {
  const incoming = track({ title: "Next song", timelineUpdatedMs: stamp, positionMs: 0 });
  let anchor = nextPlayheadAnchor(anchorAt(170_000), incoming, 1000, 1000);
  for (let now = 1250; now <= 6000; now += 250) {
    anchor = nextPlayheadAnchor(anchor, incoming, now, now);
    expect(playheadAt(anchor, now)).toBe(now - 1000);
  }
  // A fresh publication can still report a real seek/repeat to zero.
  const restarted = nextPlayheadAnchor(anchor, { ...incoming, timelineUpdatedMs: 7000 }, 7000, 7000);
  expect(playheadAt(restarted, 7000)).toBe(0);
});

test("a new track recovers from a missing timeline and paused transition without inheriting old time", () => {
  let anchor = nextPlayheadAnchor(anchorAt(170_000), track({ title: "Next song", hasTimeline: false, durationMs: 0 }), 1000);
  anchor = nextPlayheadAnchor(anchor, track({ title: "Next song", playing: false }), 1100);
  anchor = nextPlayheadAnchor(anchor, track({ title: "Next song" }), 1200);
  expect(playheadAt(anchor, 3200)).toBe(2000);
});

test.each([
  { hasTimeline: false, durationMs: 0 },
  { hasTimeline: false, durationMs: 180_000 },
  { hasTimeline: true, durationMs: 0 },
])("a missing timeline stops the clock after native expiry (%j)", (timeline) => {
  const next = nextPlayheadAnchor(
    anchorAt(30_000, 1_000, { sampleStampMs: 5_000 }),
    track({
      ...timeline,
      positionMs: 0,
      canSeek: false,
      timelineUpdatedMs: undefined,
      sampledAtMs: 6_000,
    }),
    6_000,
    6_500,
  );
  expect(next.baseMs).toBe(0);
  expect(next.at).toBe(6_000);
  expect(next.playing).toBe(false);
  expect(playheadAt(next, 6_000)).toBe(0);
  expect(playheadAt(next, 60_000)).toBe(0);
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

test("the first valid publication is fresh even when it starts at zero", () => {
  const next = nextPlayheadAnchor(
    anchorAt(30_000, 1_000, { sampleStampMs: null }),
    track({ positionMs: 0, timelineUpdatedMs: 5_000, sampledAtMs: 2_000 }),
    2_000,
    2_000,
  );
  expect(next.baseMs).toBe(0);
  expect(next.at).toBe(2_000);
  expect(next.sampleStampMs).toBe(5_000);
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

test("stale repeated timeline stamp does not pull smooth playhead backwards", () => {
  // At now = 1000, base was 10_000.
  // At now = 2000, local playhead has naturally reached 11_000.
  // A poll arrives reporting same timelineUpdatedMs with positionMs = 10_000 (unupdated sample).
  const previous = anchorAt(10_000, 1_000, { sampleStampMs: 5_000 });
  const next = nextPlayheadAnchor(
    previous,
    track({ positionMs: 10_000, timelineUpdatedMs: 5_000, sampledAtMs: 2_000 }),
    2_000,
    2_000,
  );
  // Must preserve forward progress at 2_000 (11_000ms), not reset base to 10_000
  expect(playheadAt(next, 2_000)).toBe(11_000);
});

test("an unchanged publication accepts a changed source position even for a small backward seek", () => {
  const previous = anchorAt(30_000, 1_000, { sampleStampMs: 5_000 });
  const next = nextPlayheadAnchor(
    previous,
    track({ positionMs: 29_700, timelineUpdatedMs: 5_000, sampledAtMs: 2_000 }),
    2_000,
    2_000,
  );
  expect(next.baseMs).toBe(29_700);
  expect(next.at).toBe(2_000);
  expect(playheadAt(next, 2_000)).toBe(29_700);
});

test("repeated identical source samples keep advancing beyond the old three-second threshold", () => {
  // Legacy anchors without sourcePositionMs must also remain compatible.
  let anchor = anchorAt(10_000, 1_000, { sampleStampMs: 5_000 });
  const positions: number[] = [];
  for (let now = 2_000; now <= 9_000; now += 1_000) {
    anchor = nextPlayheadAnchor(
      anchor,
      track({ positionMs: 10_000, timelineUpdatedMs: 5_000, sampledAtMs: now }),
      now,
      now,
    );
    positions.push(playheadAt(anchor, now));
  }
  expect(positions).toEqual([11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 17_000, 18_000]);
  expect(anchor.baseMs).toBe(10_000);
  expect(anchor.at).toBe(1_000);
});

test("repeated raw samples are recognized after IPC projection without adding flight time twice", () => {
  let anchor = nextPlayheadAnchor(
    anchorAt(0),
    track({ positionMs: 10_000, timelineUpdatedMs: 5_000, sampledAtMs: 1_000 }),
    1_000,
    1_250,
  );
  const positions: number[] = [];
  for (let now = 2_000; now <= 5_000; now += 1_000) {
    anchor = nextPlayheadAnchor(
      anchor,
      track({ positionMs: 10_000, timelineUpdatedMs: 5_000, sampledAtMs: now }),
      now,
      now + 250,
    );
    positions.push(playheadAt(anchor, now));
  }
  expect(positions).toEqual([11_250, 12_250, 13_250, 14_250]);
  expect(anchor.baseMs).toBe(10_250);
  expect(anchor.at).toBe(1_000);
});

test("stale repeated timeline stamp still accepts large backward seek", () => {
  const previous = anchorAt(50_000, 1_000, { sampleStampMs: 5_000 });
  // Player jumped back 20 seconds, backward drift is > 3000ms
  const next = nextPlayheadAnchor(
    previous,
    track({ positionMs: 30_000, timelineUpdatedMs: 5_000, sampledAtMs: 2_000 }),
    2_000,
    2_000,
  );
  expect(next.baseMs).toBe(30_000);
  expect(playheadAt(next, 2_000)).toBe(30_000);
});

test("playhead correctly reflects elapsed time after notch remains closed for a long time", () => {
  // Notch was closed at performance.now() = 1_000, baseMs = 15_000 (15s into song)
  const closedAnchor = anchorAt(15_000, 1_000, { sampleStampMs: 10_000 });

  // 5 minutes (300_000 ms) pass while notch is closed.
  const reopenNow = 301_000;

  // Local playhead evaluated instantly on reopen must reflect 315_000 ms (clamped to duration)
  const initialOpenPlayhead = playheadAt(closedAnchor, reopenNow);
  expect(initialOpenPlayhead).toBe(180_000); // 180_000 is durationMs in anchorAt

  // For a longer track (e.g. 600s duration):
  const longTrackAnchor = anchorAt(15_000, 1_000, {
    durationMs: 600_000,
    sampleStampMs: 10_000,
  });
  const reopenPlayhead = playheadAt(longTrackAnchor, reopenNow);
  expect(reopenPlayhead).toBe(315_000); // 15s + 300s elapsed = 315s

  // Incoming media snapshot after reopen with fresh position advances anchor smoothly without resetting to 0
  const freshSnapshot = track({
    positionMs: 315_200,
    durationMs: 600_000,
    timelineUpdatedMs: 310_000,
    sampledAtMs: 301_000,
  });
  const updatedAnchor = nextPlayheadAnchor(longTrackAnchor, freshSnapshot, reopenNow, 301_000);
  expect(updatedAnchor.baseMs).toBe(315_200);
  expect(playheadAt(updatedAnchor, reopenNow)).toBe(315_200);
});

test("bogus zero timeline after long closed period does not reset playhead to 0", () => {
  const longTrackAnchor = anchorAt(100_000, 1_000, {
    durationMs: 600_000,
    sampleStampMs: 50_000,
  });
  const reopenNow = 121_000; // 2 minutes later
  // Background player briefly emits position 0 with stale stamp
  const bogusZero = track({
    positionMs: 0,
    durationMs: 600_000,
    timelineUpdatedMs: 50_000,
    sampledAtMs: 121_000,
  });
  const anchorAfterBogusZero = nextPlayheadAnchor(longTrackAnchor, bogusZero, reopenNow, 121_000);
  // Must ignore bogus zero and continue advancing from previous anchor
  expect(anchorAfterBogusZero.baseMs).toBe(100_000);
  expect(playheadAt(anchorAfterBogusZero, reopenNow)).toBe(220_000);
});
