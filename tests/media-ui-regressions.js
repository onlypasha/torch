import { emit } from "@tauri-apps/api/event";
import { clearLyricsCache } from "../src/lyrics.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRACK = {
  title: "Audit A", artist: "Audit Band", album: "Audit Album", source: "Audit.exe",
  playing: false, positionMs: 10_000, durationMs: 180_000, hasTimeline: true,
  canSeek: true, canToggle: true, canNext: true, canPrevious: true,
  shuffle: false, shuffleSupported: false, repeat: "none", repeatSupported: false,
  playbackRate: 1,
};
const OTHER = { ...TRACK, title: "Audit B", positionMs: 5_000, durationMs: 240_000 };
const bar = () => document.querySelector(".notch-media-track");
const position = () => Number(bar()?.getAttribute("aria-valuenow"));
const seeks = () => window.__notchCommands.filter((entry) => entry.command === "media_seek");
const lyric = () => document.querySelector(".notch-media-lyric-line")?.textContent ?? "";
const check = (ok, message) => { if (!ok) throw new Error(message); };
const put = async (media) => { await emit("media-state", media); await wait(100); };
function pointer(type, ratio, pointerId = 7) {
  const element = bar();
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: type === "pointerup" ? 0 : 1,
    clientX: rect.left + rect.width * ratio, clientY: rect.top + rect.height / 2,
  }));
}
async function seek(ratio) {
  pointer("pointerdown", ratio);
  await wait(60);
  pointer("pointerup", ratio);
  await wait(100);
  return seeks().at(-1)?.args;
}

/** Real useNook and SeekBar, with only the Windows/network boundaries mocked. */
export async function runMediaRegression(scenario) {
  const originalFetch = window.fetch;
  clearLyricsCache();
  window.fetch = async () => new Response("{}", { status: 404 });
  try {
    if (document.querySelector("[data-notch]")?.getAttribute("aria-expanded") !== "true") {
      await emit("notch-press", null);
      await wait(950);
    }
    await put(null);
    await put(TRACK);
    const before = seeks().length;
    switch (scenario) {
      case "song-transition-clock": {
        const track = { ...OTHER, positionMs: 0, playing: true, timelineUpdatedMs: 1234 };
        window.fetch = async () => new Response(JSON.stringify({
          trackName: track.title, artistName: track.artist, duration: 240,
          syncedLyrics: "[00:00]Beginning\n[00:01]Moving words\n[00:02]Still moving",
        }));
        await put({ ...track, playing: false, hasTimeline: false, durationMs: 0 });
        await put(track);
        // Some players repeat zero during their transition; metadata/artwork
        // snapshots must not reset the animation anchor each time.
        for (let tick = 0; tick < 12; tick++) {
          await wait(150);
          await put(track);
        }
        check(position() >= 2, `the next song must keep advancing, got ${position()}s`);
        check(lyric() === "Still moving", `lyrics must follow the new song's clock, got ${lyric()}`);
        break;
      }
      case "cancel":
        pointer("pointerdown", .75);
        await wait(100);
        pointer("pointercancel", .75);
        await wait(100);
        check(seeks().length === before, "pointercancel must not submit a seek");
        check(position() === 10, `cancel must restore 10s, got ${position()}`);
        break;
      case "track-change":
      case "track-round-trip":
        pointer("pointerdown", .75);
        await wait(100);
        await put(OTHER);
        if (scenario === "track-round-trip") await put(TRACK);
        pointer("pointermove", .8);
        pointer("pointerup", .75);
        await wait(100);
        check(seeks().length === before, "an abandoned track's drag must never seek a new session");
        check(position() === (scenario === "track-round-trip" ? 10 : 5), "abandoned preview must not survive a track change");
        break;
      case "capability-change":
        pointer("pointerdown", .75);
        await wait(100);
        await put({ ...TRACK, canSeek: false });
        pointer("pointerup", .75);
        await wait(100);
        check(seeks().length === before, "revoked seek capability must cancel an in-flight drag");
        break;
      case "lost-capture":
        pointer("pointerdown", .75);
        await wait(100);
        pointer("lostpointercapture", .75);
        await wait(100);
        check(seeks().length === before && position() === 10, "lost capture must cancel, not leave a preview or commit");
        break;
      case "late-result": {
        const request = await seek(.75);
        await put(OTHER);
        await emit("media-seek", { token: request.token, applied: true, positionMs: 135_000 });
        await wait(100);
        check(position() === 5, `old track's seek reply must not move B, got ${position()}`);
        break;
      }
      case "new-drag-old-result": {
        const request = await seek(.75);
        pointer("pointerdown", .25);
        await wait(100);
        await emit("media-seek", { token: request.token, applied: true, positionMs: 135_000 });
        await wait(100);
        check(position() === 45, `old seek reply must not erase the new drag, got ${position()}`);
        pointer("pointercancel", .25);
        break;
      }
      case "near-sample-then-result": {
        const request = await seek(.75);
        await put({ ...TRACK, positionMs: 135_000 });
        await emit("media-seek", { token: request.token, applied: false, positionMs: 135_000 });
        await wait(100);
        check(document.querySelector(".notch-media-times [data-notice]")?.textContent === "Seek ditolak", "a nearby timeline sample must not discard the awaited request identity");
        break;
      }
      case "timeout":
        await seek(.5);
        await wait(3250);
        check(position() === 10, `a missing worker reply must release the hold without media events, got ${position()}`);
        break;
      case "null-session":
        await put(null);
        await wait(150);
        check(position() === 0, `no session must reset the clock, got ${position()}`);
        break;
      case "timeline-expiry":
        await seek(.5);
        await put({ ...TRACK, hasTimeline: false, durationMs: 0, positionMs: 0, canSeek: false });
        check(position() === 0, `expired native timeline must also discard optimistic seek, got ${position()}`);
        check(bar().dataset.interactive === "false", "expired timeline must disable seek");
        break;
      case "untokened-result":
        await seek(.5);
        await emit("media-seek", { applied: true, positionMs: 135_000 });
        await wait(100);
        check(position() === 90, "an uncorrelated reply must not settle an active request");
        break;
      case "keyboard": {
        for (const [key, seconds] of [["ArrowRight", 15], ["Home", 0], ["End", 180]]) {
          bar().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          await wait(100);
          const request = seeks().at(-1)?.args;
          check(request?.positionMs === seconds * 1000, `keyboard ${key} must request ${seconds}s`);
          await emit("media-seek", { token: request.token, applied: true, positionMs: request.positionMs });
          await wait(100);
          check(position() === seconds, `keyboard ${key} confirmation must settle`);
        }
        break;
      }
      case "duration-correction":
      case "duration-jitter": {
        const calls = [];
        window.fetch = async (input) => {
          const url = String(input);
          calls.push(url);
          const params = new URL(url).searchParams;
          const body = {
            trackName: params.get("track_name"), artistName: params.get("artist_name"),
            duration: Number(params.get("duration")),
            syncedLyrics: `[00:00.00]Sheet ${params.get("duration")}`,
          };
          return new Response(JSON.stringify(body));
        };
        const track = { ...TRACK, title: `Duration ${scenario}` };
        await put(track);
        await wait(400);
        check(lyric() === "Sheet 180", `initial lyrics must be ready, got ${lyric()}`);
        const count = calls.length;
        if (scenario === "duration-correction") {
          await put({ ...track, durationMs: 240_000 });
          await wait(400);
          check(calls.length > count && lyric() === "Sheet 240", "a corrected duration must revalidate the lyric sheet");
        } else {
          await put({ ...track, durationMs: 181_000 });
          await put(track);
          await wait(400);
          check(calls.length === count, "duration jitter within the matching tolerance must not refetch");
        }
        break;
      }
      case "plain-marquee":
      case "synced-marquee": {
        const first = "A long lyric sentence that must scroll across the narrow media panel so every word can be read";
        const second = "The second verse must also remain readable when the lyrics have no timestamps";
        const plain = scenario === "plain-marquee";
        const track = { ...TRACK, title: scenario };
        window.fetch = async () => new Response(JSON.stringify({
          trackName: track.title, artistName: track.artist, duration: 180,
          ...(plain ? { plainLyrics: `${first}\n${second}` } : { syncedLyrics: `[00:00]${first}` }),
        }));
        await put(track);
        await wait(500);
        check(lyric() === (plain ? `${first} ${second}` : first), "the inline strip must contain all lyric words");
        const scrolling = document.querySelector(".notch-media-lyric .notch-marquee-inner");
        check(scrolling?.dataset.scroll === "true", "long lyrics must enable overflow scrolling");
        check(getComputedStyle(scrolling).animationName === "notch-marquee", "the lyric marquee must animate");
        const box = scrolling.parentElement.getBoundingClientRect();
        check(box.width > 0 && box.right <= document.querySelector(".notch-media-info").getBoundingClientRect().right + 1,
          "the lyric marquee must fit inside the media column");
        break;
      }
      case "instrumental":
        window.fetch = async () => new Response(JSON.stringify({
          trackName: TRACK.title, artistName: TRACK.artist, duration: 180,
          syncedLyrics: "[00:05.00]Verse\n[00:10.00]\n[00:30.00]Next verse",
        }));
        clearLyricsCache();
        await put({ ...TRACK, title: "Different track" });
        await put({ ...TRACK, positionMs: 15_000 });
        await wait(450);
        check(document.querySelector(".notch-media-lyric")?.dataset.status === "ready", "instrumental still belongs to a valid lyric sheet");
        check(lyric() === "", `instrumental must not display old words or unavailable, got ${lyric()}`);
        break;
      default:
        throw new Error(`Unknown media regression: ${scenario}`);
    }
    return { scenario, ok: true };
  } finally {
    window.fetch = originalFetch;
    clearLyricsCache();
  }
}
