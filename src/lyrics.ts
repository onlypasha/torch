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

export type LyricsStatus =
  | "idle"
  | "loading"
  | "ready"
  | "plain"
  | "unavailable"
  | "failed";

export type LyricsState = {
  status: LyricsStatus;
  lines: LyricLine[];
  /** Untimed words, shown as one block instead of being advanced. */
  plain: string;
};

export const LYRIC_UNAVAILABLE = "Lirik belum tersedia";
export const LYRIC_LOADING = "Mencari lirik…";
export const LYRIC_FAILED = "Lirik tidak dapat dimuat";

const ENDPOINT = "https://lrclib.net/api";
const TIMEOUT_MS = 7000;
/** A neighbourhood of recent tracks, so flipping back and forth is free. */
const CACHE_LIMIT = 64;
const cache = new Map<string, LyricsSheet | null>();

/** Drop "(feat. ...)", "- Remastered" and similar before asking the service. */
export function cleanTrackTitle(title: string): string {
  return title
    .replace(/\s*[([/]\s*(feat|ft|featuring|with)\.?\s+.*?[)\]]/gi, "")
    .replace(/\s+-\s+.*?(remaster|radio edit|single|version|acoustic|live).*$/i, "")
    .trim();
}

/**
 * LRC is a pile of `[mm:ss.xx]` prefixes, sometimes several on one line.
 * Lines without a timestamp (metadata tags such as `[ar:…]`) are metadata,
 * but global `[offset:+-ms]` shifts the entire lyric timeline.
 */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  const offsetRegex = /\[offset:\s*([+-]?\d+)\s*\]/i;
  let globalOffsetMs = 0;

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const offsetMatch = offsetRegex.exec(trimmed);
    if (offsetMatch) {
      const parsedOffset = Number(offsetMatch[1]);
      if (Number.isFinite(parsedOffset)) {
        globalOffsetMs = parsedOffset;
      }
      continue;
    }

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
    for (const timeMs of times) {
      // In standard LRC, positive offset means lyric plays later: effective time is stamp - offset
      lines.push({ timeMs: Math.max(0, timeMs - globalOffsetMs), text: words });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line being sung, or -1 before the first one starts. */
export function activeLyricIndex(
  lines: readonly LyricLine[],
  positionMs: number,
  leadMs: number = 0,
): number {
  if (lines.length === 0) return -1;
  const effectiveMs = positionMs + leadMs;
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= effectiveMs) {
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
  leadMs: number = 0,
): { index: number; previous: string; current: string; next: string } {
  if (lines.length === 0) {
    return { index: -1, previous: "", current: "", next: "" };
  }
  const index = activeLyricIndex(lines, positionMs, leadMs);
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
  albumName?: string;
};

/** One answer from the service: timed words, or a static block. */
export type LyricsSheet = {
  lines: LyricLine[];
  /** Untimed words, empty when `lines` is what should be shown. */
  plain: string;
};

/**
 * The search endpoint returns several performances of the same song. Prefer a
 * synced one, then the recording whose length matches the player's - a live
 * version with the same title would otherwise scroll the wrong words.
 * Rejects candidates whose duration difference exceeds MAX_DURATION_DIFF_SEC (2s)
 * when player duration is known.
 */
export const MAX_DURATION_DIFF_SEC = 2.0;

/**
 * Words that mark a different performance. They are kept in the title when the
 * service is searched (a live recording needs the live words), and used here to
 * prefer a candidate that carries the same marker instead of silently swapping
 * in the studio version.
 */
const VERSION_MARKERS = [
  "live",
  "acoustic",
  "instrumental",
  "karaoke",
  "remix",
  "demo",
  "cover",
  "sped up",
  "nightcore",
];

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasMarker(text: string, marker: string): boolean {
  const pattern = escapePattern(marker).replace(/\s+/g, "[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, "i").test(text);
}

function versionMarkers(title: string): string[] {
  return VERSION_MARKERS.filter((marker) => hasMarker(title, marker));
}

function plainText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

type Ranked = { item: Candidate; score: number };

function rank(
  items: readonly Candidate[],
  durationMs: number,
  markers: readonly string[],
): Ranked[] {
  const target = durationMs > 0 ? durationMs / 1000 : 0;
  return items
    .map((item) => {
      const known = typeof item.duration === "number" && item.duration > 0;
      const diff = target > 0 && known ? Math.abs((item.duration as number) - target) : Number.POSITIVE_INFINITY;
      const text = `${item.trackName ?? ""} ${item.albumName ?? ""}`;
      // Missing or extra version markers make a wrong-performance match much
      // more likely than a second of duration drift, so they weigh more.
      const misses = markers.filter((marker) => !hasMarker(text, marker)).length
        + VERSION_MARKERS.filter((marker) => !markers.includes(marker) && hasMarker(text, marker)).length;
      const lengthScore = target > 0 ? (known ? diff : 99) : 0;
      return { item, score: misses * 6 + lengthScore };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * A candidate of a very different length is a different recording, whatever
 * its title says. Unknown lengths stay in: refusing them would discard the only
 * answer for a stream that reports no duration of its own.
 */
function lengthMatches(item: Candidate, durationMs: number): boolean {
  if (durationMs <= 0) return true;
  const known = typeof item.duration === "number" && item.duration > 0;
  return !known || Math.abs((item.duration as number) - durationMs / 1000) <= MAX_DURATION_DIFF_SEC;
}

/**
 * Choose the best answer, including a plain one when nothing timed fits.
 * Duration and version markers are applied to both kinds, so a mismatched
 * studio sheet is not used just because it happens to have timestamps.
 */
export function pickSheet(
  candidates: readonly Candidate[],
  durationMs: number,
  title = "",
): LyricsSheet | null {
  const markers = versionMarkers(title);

  const synced = candidates.filter(
    (item): item is Candidate & { syncedLyrics: string } =>
      typeof item.syncedLyrics === "string" &&
      item.syncedLyrics.trim().length > 0 &&
      lengthMatches(item, durationMs),
  );
  const bestSynced = rank(synced, durationMs, markers)[0];
  if (bestSynced) {
    const lines = parseLrc((bestSynced.item as Candidate & { syncedLyrics: string }).syncedLyrics);
    if (lines.length > 0) return { lines, plain: "" };
  }

  const plain = candidates.filter(
    (item): item is Candidate & { plainLyrics: string } =>
      plainText(item.plainLyrics).length > 0 && lengthMatches(item, durationMs),
  );
  const bestPlain = rank(plain, durationMs, markers)[0];
  if (bestPlain) {
    return {
      lines: [],
      plain: plainText((bestPlain.item as Candidate & { plainLyrics: string }).plainLyrics),
    };
  }
  return null;
}

/** How the widget's clock and search tests consume a result: timed rows only. */
export function pickBest(
  candidates: readonly Candidate[],
  durationMs: number,
  title = "",
): LyricLine[] | null {
  const sheet = pickSheet(candidates, durationMs, title);
  return sheet && sheet.lines.length > 0 ? sheet.lines : null;
}

function remember(key: string, value: LyricsSheet | null): void {
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
  album?: string;
  durationMs: number;
  signal?: AbortSignal;
};

/**
 * Exact match first (cheap and precise), then a search. Both answers are
 * cached by cleaned title/artist/album/length so a repeated poll costs nothing.
 * The length in the key means a sheet found while the duration was still
 * unknown is looked up again once the player reports one.
 */
export async function fetchLyricsSheet({
  title,
  artist,
  album,
  durationMs,
  signal,
}: LyricsRequest): Promise<LyricsSheet | null> {
  signal?.throwIfAborted();
  const clean = cleanTrackTitle(title);
  if (!clean || !artist.trim()) return null;
  const albumPart = album?.trim().toLowerCase() ?? "";
  const key = `${clean.toLowerCase()}|${artist.trim().toLowerCase()}|${albumPart}|${Math.round(durationMs / 1000)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Lyrics request timed out", "TimeoutError")), TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    let query = `?track_name=${encodeURIComponent(clean)}&artist_name=${encodeURIComponent(artist.trim())}`;
    if (album?.trim()) {
      query += `&album_name=${encodeURIComponent(album.trim())}`;
    }
    if (durationMs > 0) {
      query += `&duration=${Math.round(durationMs / 1000)}`;
    }
    // An exact answer with timestamps settles it. An exact answer with plain
    // words is kept as a fallback while the search looks for a timed version
    // of the same recording, rather than giving up on sync too early.
    let exactSheet: LyricsSheet | null = null;
    const exact = await request(`/get${query}`, timeout.signal);
    if (exact.ok) {
      const body = (await exact.json()) as Candidate;
      exactSheet = pickSheet([body], durationMs, title);
      if (exactSheet && exactSheet.lines.length > 0) {
        remember(key, exactSheet);
        return exactSheet;
      }
    }

    const searchQuery = album?.trim()
      ? `${clean} ${artist.trim()} ${album.trim()}`
      : `${clean} ${artist.trim()}`;
    const search = await request(
      `/search?q=${encodeURIComponent(searchQuery)}`,
      timeout.signal,
    );
    if (search.ok) {
      const body = (await search.json()) as Candidate[];
      const found = Array.isArray(body) ? pickSheet(body, durationMs, title) : null;
      const sheet = found && (found.lines.length > 0 || !exactSheet) ? found : exactSheet;
      remember(key, sheet);
      return sheet;
    }

    // A 404 is an answer ("this track has no lyrics"), not a network failure;
    // caching it keeps the next poll from asking again.
    if (search.status === 404) {
      remember(key, exactSheet);
      return exactSheet;
    }
    return exactSheet;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Timed rows only; a plain sheet has no position to follow. */
export async function fetchLyrics(request: LyricsRequest): Promise<LyricLine[] | null> {
  const sheet = await fetchLyricsSheet(request);
  return sheet && sheet.lines.length > 0 ? sheet.lines : null;
}

/** Test seam: the cache would otherwise leak between cases. */
export function clearLyricsCache(): void {
  cache.clear();
}
