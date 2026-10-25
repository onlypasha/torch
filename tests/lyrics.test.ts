import { expect, test } from "bun:test";
import {
  activeLyricIndex,
  cleanTrackTitle,
  clearLyricsCache,
  lyricWindow,
  parseLrc,
  pickBest,
  pickSheet,
} from "../src/lyrics";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("LRC timestamps become milliseconds, including decimal seconds", () => {
  const lines = parseLrc(
    ["[00:00.00]Satu", "[00:12.50]Dua", "[01:02.345]Tiga", "[abc]Bukan lirik"].join("\n"),
  );
  expect(lines).toEqual([
    { timeMs: 0, text: "Satu" },
    { timeMs: 12_500, text: "Dua" },
    { timeMs: 62_345, text: "Tiga" },
  ]);
});

test("the older mm:ss:cc stamp is read as centiseconds", () => {
  expect(parseLrc("[01:02:99]Tiga")).toEqual([{ timeMs: 62_990, text: "Tiga" }]);
});

test("metadata tags and blank lines are not lyrics", () => {
  const lines = parseLrc(["[ar:Contoh Band]", "[ti:Malam Ini]", "", "[00:03.00]Halo"].join("\n"));
  expect(lines).toEqual([{ timeMs: 3_000, text: "Halo" }]);
});

test("a line with several stamps plays at each of them", () => {
  const lines = parseLrc("[00:05.00][00:20.00]Ulang");
  expect(lines.map((line) => line.timeMs)).toEqual([5_000, 20_000]);
  expect(lines.every((line) => line.text === "Ulang")).toBe(true);
});

test("lines are ordered even when the file is not", () => {
  const lines = parseLrc("[00:20.00]B\n[00:05.00]A");
  expect(lines.map((line) => line.text)).toEqual(["A", "B"]);
});

test("a file with no timed lines is not a lyric sheet", () => {
  expect(parseLrc("hanya teks tanpa waktu")).toEqual([]);
  expect(parseLrc("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// Which line is being sung
// ---------------------------------------------------------------------------

const LINES = [
  { timeMs: 0, text: "Awal" },
  { timeMs: 10_000, text: "Tengah" },
  { timeMs: 20_000, text: "Akhir" },
];

test("the active line is the last one that has started", () => {
  expect(activeLyricIndex(LINES, 0)).toBe(0);
  expect(activeLyricIndex(LINES, 9_999)).toBe(0);
  expect(activeLyricIndex(LINES, 10_000)).toBe(1);
  expect(activeLyricIndex(LINES, 19_999)).toBe(1);
  expect(activeLyricIndex(LINES, 60_000)).toBe(2);
});

test("before the first line there is nothing to highlight", () => {
  const late = [{ timeMs: 4_000, text: "Nanti" }];
  expect(activeLyricIndex(late, 1_000)).toBe(-1);
  expect(lyricWindow(late, 1_000).current).toBe("Nanti");
  expect(lyricWindow(late, 1_000).previous).toBe("");
});

test("the window carries the previous and next lines for context", () => {
  const middle = lyricWindow(LINES, 12_000);
  expect(middle).toEqual({ index: 1, previous: "Awal", current: "Tengah", next: "Akhir" });

  const last = lyricWindow(LINES, 30_000);
  expect(last).toEqual({ index: 2, previous: "Tengah", current: "Akhir", next: "" });

  expect(lyricWindow([], 5_000)).toEqual({ index: -1, previous: "", current: "", next: "" });
});

// ---------------------------------------------------------------------------
// Choosing an answer from the service
// ---------------------------------------------------------------------------

const synced = (text: string) => `[00:00.00]${text}`;

test("the recording whose length matches the player wins", () => {
  const candidates = [
    { syncedLyrics: synced("Live"), duration: 245 },
    { syncedLyrics: synced("Studio"), duration: 181 },
    { syncedLyrics: synced("Remix"), duration: 320 },
  ];
  const picked = pickBest(candidates, 180_000);
  expect(picked?.[0].text).toBe("Studio");
});

test("only synced answers are usable", () => {
  expect(pickBest([{ plainLyrics: "tanpa waktu", duration: 180 }], 180_000)).toBeNull();
  expect(pickBest([{ syncedLyrics: "  ", duration: 180 }], 180_000)).toBeNull();
  expect(pickBest([], 180_000)).toBeNull();
});

test("an unknown duration still picks a synced answer", () => {
  const picked = pickBest([{ syncedLyrics: synced("Satu"), duration: 240 }], 0);
  expect(picked?.[0].text).toBe("Satu");
});

test("untimed words are a plain sheet, never a timed one", () => {
  const sheet = pickSheet([{ plainLyrics: "  Baris satu\n\nBaris dua  ", duration: 180 }], 180_000);
  expect(sheet).toEqual({ lines: [], plain: "Baris satu\nBaris dua" });
  // The seekbar/clock must not be handed a fake timeline for them.
  expect(pickBest([{ plainLyrics: "Baris satu", duration: 180 }], 180_000)).toBeNull();
});

test("a live recording gets the live words, not the studio ones", () => {
  const candidates = [
    { syncedLyrics: synced("Studio"), duration: 180, trackName: "Lagu", albumName: "Album" },
    { syncedLyrics: synced("Live"), duration: 180, trackName: "Lagu", albumName: "Live at Wembley" },
  ];
  expect(pickSheet(candidates, 180_000, "Lagu - Live at Wembley")?.lines[0].text).toBe("Live");
  expect(pickSheet(candidates, 180_000, "Lagu")?.lines[0].text).toBe("Studio");
});

test("a mismatched performance falls back to plain words instead of wrong timing", () => {
  const candidates = [
    { syncedLyrics: synced("Extended"), duration: 240, trackName: "Lagu", albumName: "Extended" },
    { plainLyrics: "Kata biasa", duration: 180, trackName: "Lagu", albumName: "Album" },
  ];
  expect(pickSheet(candidates, 180_000, "Lagu")).toEqual({ lines: [], plain: "Kata biasa" });
});

test("bracketed noise is removed before asking the service", () => {
  expect(cleanTrackTitle("Lagu (feat. Orang)")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu [Remastered 2011]")).toBe("Lagu [Remastered 2011]");
  expect(cleanTrackTitle("Lagu - Remastered 2011")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu - Live at Wembley")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu")).toBe("Lagu");
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

test("a fetched sheet is cached and asked for once", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ syncedLyrics: "[00:00.00]Halo", duration: 180 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const first = await fetchLyricsFor("Judul Uji", "Artis Uji");
    const second = await fetchLyricsFor("Judul Uji", "Artis Uji");
    expect(first?.[0].text).toBe("Halo");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a sheet found without a duration is looked up again once it is known", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ syncedLyrics: "[00:00.00]Halo", duration: 180 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    const unknown = await fetchLyricsSheet({ title: "Judul Uji", artist: "Artis Uji", durationMs: 0 });
    const known = await fetchLyricsSheet({ title: "Judul Uji", artist: "Artis Uji", durationMs: 180_000 });
    expect(unknown?.lines[0].text).toBe("Halo");
    expect(known?.lines[0].text).toBe("Halo");
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("a track with no artist is not sent to the service at all", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const { fetchLyrics } = await import("../src/lyrics");
    expect(await fetchLyrics({ title: "Judul", artist: "  ", durationMs: 180_000 })).toBeNull();
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

async function fetchLyricsFor(title: string, artist: string) {
  const { fetchLyrics } = await import("../src/lyrics");
  return fetchLyrics({ title, artist, durationMs: 180_000 });
}

test("an already-aborted lyric request neither fetches nor returns cached data", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ syncedLyrics: synced("Cache"), duration: 180 }));
  }) as typeof fetch;
  try {
    await fetchLyricsFor("Cached", "Artist");
    const controller = new AbortController();
    controller.abort();
    const { fetchLyrics } = await import("../src/lyrics");
    await expect(fetchLyrics({ title: "Cached", artist: "Artist", durationMs: 180_000, signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("switching songs aborts an in-flight lyric request without caching failure", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_input, options) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ syncedLyrics: synced("Recovered"), duration: 180 })));
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const { fetchLyrics } = await import("../src/lyrics");
    const pending = fetchLyrics({ title: "Cancelled", artist: "Artist", durationMs: 180_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect((await fetchLyricsFor("Cancelled", "Artist"))?.[0].text).toBe("Recovered");
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});
