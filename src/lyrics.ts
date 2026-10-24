/**
 * Timed lyrics, fetched from LRCLIB - the same public LRC source the WPF
 * original used. Windows' own media session carries no lyrics, so this is the
 * only place the words can come from; when the service has nothing for a track
 * the widget says so instead of inventing verses.
 *
 * The fetch lives in the webview because LRCLIB answers with
 * `access-control-allow-origin: *`; a native proxy would add an HTTP stack to
 * the Rust side for no behavioural gain.
 */

export type LyricLine = { timeMs: number; text: string };

export type LyricsStatus = "idle" | "loading" | "ready" | "unavailable" | "failed";

export type LyricsState = {
  status: LyricsStatus;
  lines: LyricLine[];
};

export const LYRIC_UNAVAILABLE = "Lirik belum tersedia";
export const LYRIC_LOADING = "Mencari lirik…";
export const LYRIC_FAILED = "Lirik tidak dapat dimuat";

const ENDPOINT = "https://lrclib.net/api";
const TIMEOUT_MS = 7000;
/** A neighbourhood of recent tracks, so flipping back and forth is free. */
const CACHE_LIMIT = 64;
const cache = new Map<string, LyricLine[] | null>();

/** Drop "(feat. ...)", "- Remastered" and similar before asking the service. */
export function cleanTrackTitle(title: string): string {
  return title
    .replace(/\s*[([/]\s*(feat|ft|featuring|with)\.?\s+.*?[)\]]/gi, "")
    .replace(/\s+-\s+.*?(remaster|radio edit|single|version|acoustic|live).*$/i, "")
    .trim();
}

/**
 * LRC is a pile of `[mm:ss.xx]` prefixes, sometimes several on one line. Lines
 * without a timestamp (metadata tags such as `[ar:…]`) are metadata, not words,
 * and are dropped.
 */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const times: number[] = [];
    let match: RegExpExecArray | null;
    stamp.lastIndex = 0;
    while ((match = stamp.exec(trimmed)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2].replace(":", "."));
      if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
        times.push(Math.round((minutes * 60 + seconds) * 1000));
      }
    }
    if (times.length === 0) continue;
    const words = trimmed.replace(stamp, "").trim();
    if (!words) continue;
    for (const timeMs of times) lines.push({ timeMs, text: words });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line being sung, or -1 before the first one starts. */
export function activeLyricIndex(lines: readonly LyricLine[], positionMs: number): number {
  if (lines.length === 0) return -1;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * The three rows the widget shows. `current` is the line being sung; `next` is
 * the one coming, so the card does not jump the moment a line lands.
 */
export function lyricWindow(
  lines: readonly LyricLine[],
  positionMs: number,
): { index: number; previous: string; current: string; next: string } {
  if (lines.length === 0) {
    return { index: -1, previous: "", current: "", next: "" };
  }
  const index = activeLyricIndex(lines, positionMs);
  const at = index < 0 ? 0 : index;
  return {
    index,
    previous: at > 0 ? lines[at - 1].text : "",
    current: lines[at].text,
    next: at + 1 < lines.length ? lines[at + 1].text : "",
  };
}

type Candidate = {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  duration?: number | null;
  trackName?: string;
  artistName?: string;
};

/**
 * The search endpoint returns several performances of the same song. Prefer a
 * synced one, then the recording whose length matches the player's - a live
 * version with the same title would otherwise scroll the wrong words.
 */
export function pickBest(candidates: readonly Candidate[], durationMs: number): LyricLine[] | null {
  const synced = candidates.filter(
    (item): item is Candidate & { syncedLyrics: string } =>
      typeof item.syncedLyrics === "string" && item.syncedLyrics.trim().length > 0,
  );
  if (synced.length === 0) return null;
  const target = durationMs > 0 ? durationMs / 1000 : 0;
  const score = (item: Candidate): number => {
    if (target <= 0 || typeof item.duration !== "number" || item.duration <= 0) return 99;
    return Math.abs(item.duration - target);
  };
  const best = [...synced].sort((a, b) => score(a) - score(b))[0];
  const lines = parseLrc(best.syncedLyrics);
  return lines.length > 0 ? lines : null;
}

function remember(key: string, value: LyricLine[] | null): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

async function request(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${ENDPOINT}${path}`, {
    signal,
    headers: { accept: "application/json" },
  });
}

export type LyricsRequest = {
  title: string;
  artist: string;
  durationMs: number;
  signal?: AbortSignal;
};

/**
 * Exact match first (cheap and precise), then a search. Both answers are
 * cached by cleaned title/artist/length so a repeated poll costs nothing.
 */
export async function fetchLyrics({
  title,
  artist,
  durationMs,
  signal,
}: LyricsRequest): Promise<LyricLine[] | null> {
  const clean = cleanTrackTitle(title);
  if (!clean || !artist.trim()) return null;
  const key = `${clean.toLowerCase()}|${artist.trim().toLowerCase()}|${Math.round(durationMs / 1000)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const query = `?track_name=${encodeURIComponent(clean)}&artist_name=${encodeURIComponent(artist.trim())}`;
    const exact = await request(`/get${query}`, timeout.signal);
    if (exact.ok) {
      const body = (await exact.json()) as Candidate;
      const lines = pickBest([body], durationMs);
      if (lines) {
        remember(key, lines);
        return lines;
      }
    }

    const search = await request(
      `/search?q=${encodeURIComponent(`${clean} ${artist.trim()}`)}`,
      timeout.signal,
    );
    if (search.ok) {
      const body = (await search.json()) as Candidate[];
      const lines = Array.isArray(body) ? pickBest(body, durationMs) : null;
      remember(key, lines);
      return lines;
    }

    // A 404 is an answer ("this track has no lyrics"), not a network failure;
    // caching it keeps the next poll from asking again.
    if (search.status === 404) {
      remember(key, null);
      return null;
    }
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Test seam: the cache would otherwise leak between cases. */
export function clearLyricsCache(): void {
  cache.clear();
}
