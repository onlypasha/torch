import { expect, test } from "bun:test";
import {
  activeLyricIndex,
  cleanTrackTitle,
  clearLyricsCache,
  lyricWindow,
  parseLrc,
  pickBest,
  pickSheet,
  normalizeLyricsQuery,
} from "../src/lyrics";

test("query normalization folds Latin accents and keeps non-Latin words", () => {
  expect(normalizeLyricsQuery("  Déjà\uFFFD Vu  ")).toBe("Deja Vu");
  expect(normalizeLyricsQuery("夜に駆ける เพลง")).toBe("夜に駆ける เพลง");
});

test("structured fallback finds an accented song despite compilation album metadata", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/get")) return new Response("{}", { status: 404 });
    expect(url.searchParams.get("track_name")).toBe("Deja & Vu");
    expect(url.searchParams.get("artist_name")).toBe("Beyonce");
    expect(url.searchParams.has("album_name")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
    return new Response(JSON.stringify([{ trackName: "Deja & Vu", artistName: "Beyonce",
      albumName: "Original Album", duration: 180, syncedLyrics: "[00:00]Found" }]));
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    const result = await fetchLyricsSheet({ title: "Déjà & Vu", artist: "Beyoncé",
      album: "Compilation 2026", durationMs: 180_000 });
    expect(result?.lines[0].text).toBe("Found");
    expect(urls).toHaveLength(2);
    expect(urls[0].searchParams.get("album_name")).toBe("Compilation 2026");
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
});

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

test("timed blank rows clear old words during instrumental sections", () => {
  const lines = parseLrc("[00:05.00]Verse\n[00:10.00][00:20.00]   \n[00:30.00]Next verse");
  expect(lines).toEqual([
    { timeMs: 5_000, text: "Verse" },
    { timeMs: 10_000, text: "" },
    { timeMs: 20_000, text: "" },
    { timeMs: 30_000, text: "Next verse" },
  ]);
  expect(lyricWindow(lines, 15_000).current).toBe("");
});

test("global offsets apply to every row regardless of metadata placement", () => {
  const rows = "[00:00.10]Start\n[00:10.00]\n[00:20.00]End";
  for (const offset of [500, -500]) {
    const top = parseLrc(`[offset:${offset}]\n${rows}`);
    const middle = parseLrc(rows.replace("[00:10.00]", `[offset:${offset}]\n[00:10.00]`));
    const bottom = parseLrc(`${rows}\n[offset:${offset}]`);
    expect(bottom).toEqual(top);
    expect(middle).toEqual(top);
    expect(top.map((line) => line.timeMs)).toEqual([Math.max(0, 100 - offset), 10_000 - offset, 20_000 - offset]);
  }
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

test("the two-second duration limit still applies to timed and plain candidates", () => {
  for (const lyrics of [{ syncedLyrics: synced("Words") }, { plainLyrics: "Words" }]) {
    for (const duration of [178, 182]) {
      expect(pickSheet([{ ...lyrics, duration }], 180_000)).not.toBeNull();
    }
    for (const duration of [177.999, 182.001]) {
      expect(pickSheet([{ ...lyrics, duration }], 180_000)).toBeNull();
    }
    expect(pickSheet([lyrics], 180_000)).not.toBeNull();
    expect(pickSheet([{ ...lyrics, duration: 240 }], 0)).not.toBeNull();
  }
});

test("only synced answers are usable", () => {
  expect(pickBest([{ plainLyrics: "tanpa waktu", duration: 180 }], 180_000)).toBeNull();
  expect(pickBest([{ syncedLyrics: "  ", duration: 180 }], 180_000)).toBeNull();
  expect(pickBest([], 180_000)).toBeNull();
});

test("an all-blank LRC is not usable and cannot hide another sheet", () => {
  const blank = { syncedLyrics: "[00:00.00]\n[00:10.00]  ", duration: 180 };
  expect(pickSheet([blank], 180_000)).toBeNull();
  expect(pickSheet([{ ...blank, plainLyrics: "Words" }], 180_000)).toEqual({ lines: [], plain: "Words" });
  expect(pickSheet([blank, { syncedLyrics: synced("Usable"), duration: 181 }], 180_000)?.lines[0].text).toBe("Usable");
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

test("a requested performance rejects a same-length studio sheet, timed or plain", () => {
  for (const lyrics of [{ syncedLyrics: synced("Studio") }, { plainLyrics: "Studio" }]) {
    expect(pickSheet([{ ...lyrics, trackName: "Lagu", artistName: "Band", duration: 180 }],
      180_000, "Lagu - Live", "Band")).toBeNull();
  }
});

test("studio requests reject an explicitly different performance, not a generic album name", () => {
  const candidate = { trackName: "Lagu", artistName: "Band", duration: 180, syncedLyrics: synced("Wrong") };
  expect(pickSheet([{ ...candidate, trackName: "Lagu - Live" }], 180_000, "Lagu", "Band")).toBeNull();
  expect(pickSheet([{ ...candidate, albumName: "Live at Wembley" }], 180_000, "Lagu", "Band")).toBeNull();
  expect(pickSheet([{ ...candidate, albumName: "Album Demo" }], 180_000, "Lagu", "Band")?.lines[0].text).toBe("Wrong");
});

test("a mismatched performance falls back to plain words instead of wrong timing", () => {
  const candidates = [
    { syncedLyrics: synced("Extended"), duration: 240, trackName: "Lagu", albumName: "Extended" },
    { plainLyrics: "Kata biasa", duration: 180, trackName: "Lagu", albumName: "Album" },
  ];
  expect(pickSheet(candidates, 180_000, "Lagu")).toEqual({ lines: [], plain: "Kata biasa" });
});

test("one overlapping title word is not a match, even for the same artist and duration", () => {
  const candidate = { trackName: "Stay With Me", artistName: "Band", duration: 180 };
  expect(pickSheet([{ ...candidate, syncedLyrics: synced("Wrong") }], 180_000, "Stay Away", "Band")).toBeNull();
  expect(pickSheet([{ ...candidate, plainLyrics: "Wrong" }], 180_000, "Stay Away", "Band")).toBeNull();
});

test("requested identity fields must be present in the service candidate", () => {
  const lyrics = { syncedLyrics: synced("Unverified"), duration: 180 };
  expect(pickSheet([{ ...lyrics, artistName: "Band" }], 180_000, "Lagu", "Band")).toBeNull();
  expect(pickSheet([{ ...lyrics, trackName: "Lagu" }], 180_000, "Lagu", "Band")).toBeNull();
  // Calls without identity metadata can still select by duration alone.
  expect(pickSheet([lyrics], 180_000)?.lines[0].text).toBe("Unverified");
});

test("base-title matching keeps punctuation, case and featured-artist variants usable", () => {
  const candidate = { trackName: "HELLO, WORLD! (feat. Guest)", artistName: "Band", duration: 180, syncedLyrics: synced("Right") };
  expect(pickSheet([candidate], 180_000, "Hello World", "band")?.lines[0].text).toBe("Right");
  expect(pickSheet([{ ...candidate, trackName: "Hello World feat. Guest", artistName: "Band feat. Guest" }],
    180_000, "Hello World", "Band")?.lines[0].text).toBe("Right");
  expect(pickSheet([{ ...candidate, trackName: "Hello World - Live", albumName: "Album Demo" }],
    180_000, "Hello World - Live at Wembley", "Band")?.lines[0].text).toBe("Right");
});

test("a completely different song with similar duration is rejected", () => {
  const candidates = [
    { syncedLyrics: synced("Wrong Song Words"), duration: 180, trackName: "Totally Different Track", artistName: "Another Singer" },
  ];
  // Searching for "Bohemian Rhapsody" by "Queen", got completely unrelated song
  expect(pickSheet(candidates, 180_000, "Bohemian Rhapsody", "Queen")).toBeNull();
});

test("bracketed noise is removed before asking the service", () => {
  expect(cleanTrackTitle("Lagu (feat. Orang)")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu feat. Orang")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu - ft. Orang - Live")).toBe("Lagu - Live");
  expect(cleanTrackTitle("Lagu [Remastered 2011]")).toBe("Lagu [Remastered 2011]");
  expect(cleanTrackTitle("Lagu - Remastered 2011")).toBe("Lagu");
  expect(cleanTrackTitle("Lagu - Live at Wembley")).toBe("Lagu - Live at Wembley");
  expect(cleanTrackTitle("Lagu - Acoustic Version")).toBe("Lagu - Acoustic Version");
  expect(cleanTrackTitle("Lagu")).toBe("Lagu");
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

test("exact lookup validates live identity before returning and searches with the performance label", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  const urls: URL[] = [];
  const studio = { trackName: "Lagu", artistName: "Band", duration: 180, syncedLyrics: synced("Studio") };
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify(url.pathname.endsWith("/get") ? studio : [
      studio, { ...studio, albumName: "Live at Wembley", syncedLyrics: synced("Live") },
    ]));
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    const request = { title: "Lagu - Live at Wembley", artist: "Band", durationMs: 180_000 };
    const sheet = await fetchLyricsSheet(request);
    expect(sheet?.lines[0].text).toBe("Live");
    expect(await fetchLyricsSheet(request)).toEqual(sheet);
    expect(urls).toHaveLength(2);
    expect(urls[0].searchParams.get("track_name")).toBe(request.title);
    expect(urls[1].searchParams.get("track_name")).toBe(request.title);
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
});

test("studio, live and acoustic requests do not share cache entries, even with unknown duration", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const title = new URL(String(input)).searchParams.get("track_name");
    return new Response(JSON.stringify({ trackName: title, artistName: "Band", albumName: "Album Demo", duration: 180, syncedLyrics: synced(title ?? "Missing") }));
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    for (const durationMs of [180_000, 0]) {
      for (const title of ["Lagu", "Lagu - Live", "Lagu - Acoustic Version"]) {
        const request = { title, artist: "Band", album: "Album Demo", durationMs };
        expect((await fetchLyricsSheet(request))?.lines[0].text).toBe(title);
        expect((await fetchLyricsSheet(request))?.lines[0].text).toBe(title);
      }
    }
    expect(calls).toBe(6);
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
});

test("a fetched sheet is cached and asked for once", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ syncedLyrics: "[00:00.00]Halo", duration: 180, trackName: "Judul Uji", artistName: "Artis Uji" }),
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
      JSON.stringify({ syncedLyrics: "[00:00.00]Halo", duration: 180, trackName: "Judul Uji", artistName: "Artis Uji" }),
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

test("valid plain exact lyrics survive a failed optional synced search", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/search?")) {
      searches += 1;
      throw new TypeError("Search network failure");
    }
    return new Response(JSON.stringify({ trackName: "Lagu", artistName: "Band", duration: 180, plainLyrics: "Words available" }));
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    const request = { title: "Lagu", artist: "Band", durationMs: 180_000 };
    await expect(fetchLyricsSheet(request)).resolves.toEqual({ lines: [], plain: "Words available" });
    await expect(fetchLyricsSheet(request)).resolves.toEqual({ lines: [], plain: "Words available" });
    // A failed optional search must remain retryable, not become a cached miss.
    expect(searches).toBe(2);
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
});

test("the bounded request timeout keeps valid plain lyrics from the exact response", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let timeoutReason: DOMException | undefined;
  globalThis.fetch = ((input, options) => {
    if (!String(input).includes("/search?")) {
      return Promise.resolve(new Response(JSON.stringify({ trackName: "Lagu", artistName: "Band", duration: 180, plainLyrics: "Words available" })));
    }
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        timeoutReason = options?.signal?.reason;
        reject(timeoutReason);
      };
      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    await expect(fetchLyricsSheet({ title: "Lagu", artist: "Band", durationMs: 180_000 }))
      .resolves.toEqual({ lines: [], plain: "Words available" });
    expect(timeoutReason?.name).toBe("TimeoutError");
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
}, 15_000);

test("external cancellation during optional search rejects instead of returning plain fallback", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    if (String(input).includes("/search?")) {
      controller.abort(new DOMException("Track changed", "AbortError"));
      // Even a transport that resolves after cancellation must not revive old words.
      return new Response("[]");
    }
    return new Response(JSON.stringify({ trackName: "Lagu", artistName: "Band", duration: 180,
      plainLyrics: "Old words", ...(controller.signal.aborted ? { syncedLyrics: synced("Retried") } : {}) }));
  }) as typeof fetch;
  try {
    const { fetchLyricsSheet } = await import("../src/lyrics");
    const request = { title: "Lagu", artist: "Band", durationMs: 180_000 };
    await expect(fetchLyricsSheet({ ...request, signal: controller.signal })).rejects.toThrow("Track changed");
    expect((await fetchLyricsSheet(request))?.lines[0].text).toBe("Retried");
    expect(calls).toBe(3);
  } finally {
    globalThis.fetch = original;
    clearLyricsCache();
  }
});

test("an already-aborted lyric request neither fetches nor returns cached data", async () => {
  clearLyricsCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ syncedLyrics: synced("Cache"), duration: 180, trackName: "Cached", artistName: "Artist" }));
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
    if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ syncedLyrics: synced("Recovered"), duration: 180, trackName: "Cancelled", artistName: "Artist" })));
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
