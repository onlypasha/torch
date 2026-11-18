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

/** Match boring.notch's diacritic-insensitive queries without losing non-Latin scripts. */
export function normalizeLyricsQuery(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\uFFFD/g, "").trim();
}

/** Remove credits/mastering noise, but keep performance labels in requests and cache keys. */
export function cleanTrackTitle(title: string): string {
  return title
    .replace(/\s*[([/]\s*(feat|ft|featuring|with)\.?\s+.*?[)\]]/gi, "")
    .replace(/\s+(?:-\s+)?(?:feat|ft|featuring)\.?\s+.*?(?=\s+-\s+|$)/gi, "")
    .replace(/\s+-\s+.*?(remaster|radio edit|single|version).*$/i, (suffix) =>
      versionMarkers(suffix).length > 0 ? suffix : "",
    )
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
    for (const timeMs of times) {
      lines.push({ timeMs, text: words });
    }
  }
  // Preserve the existing stamp-minus-offset convention, applying metadata globally.
  for (const line of lines) line.timeMs = Math.max(0, line.timeMs - globalOffsetMs);
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
 * require a candidate that carries the same marker instead of silently swapping
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

function normalizeForMatch(text: string): string {
  return normalizeLyricsQuery(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip performance qualifiers only for comparing the song's base title. */
function baseTrackTitle(title: string): string {
  return normalizeForMatch(cleanTrackTitle(title)
    .replace(/\s*[([]([^)[\]]*)[)\]]/g, (suffix, qualifier: string) =>
      versionMarkers(qualifier).length > 0 ? "" : suffix,
    )
    .replace(/\s+-\s+(.+)$/, (suffix, qualifier: string) =>
      versionMarkers(qualifier).length > 0 ? "" : suffix,
    ));
}

/** Known request fields require metadata; compare the entire normalized base title. */
function matchesTrack(candidate: Candidate, title: string, artist: string): boolean {
  const cleanTitle = baseTrackTitle(title);
  if (cleanTitle && cleanTitle !== baseTrackTitle(candidate.trackName ?? "")) return false;

  const cleanArtist = normalizeForMatch(artist);
  const candArtist = normalizeForMatch(candidate.artistName ?? "");
  if (cleanArtist && !candArtist) return false;
  if (cleanArtist && candArtist) {
    const artistTokens = cleanArtist.split(" ").filter((t) => t.length > 1);
    const candArtistTokens = candArtist.split(" ").filter((t) => t.length > 1);
    const matchedArtist = artistTokens.filter((token) => candArtistTokens.includes(token));
    if (artistTokens.length > 0 && matchedArtist.length === 0) {
      return false;
    }
  }

  return true;
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
  artist = "",
): LyricsSheet | null {
  const markers = versionMarkers(title);
  const filtered = candidates.filter((item) => {
    if (!matchesTrack(item, title, artist)) return false;
    const candidateTitle = item.trackName ?? "";
    const album = item.albumName ?? "";
    if (!markers.every((marker) => hasMarker(`${candidateTitle} ${album}`, marker))) return false;
    // Album names alone are weak evidence of a demo/cover (e.g. "Album Demo").
    // Explicit title markers and album performance labels must still agree.
    return !title || VERSION_MARKERS.every((marker) => markers.includes(marker) ||
      (!hasMarker(candidateTitle, marker) &&
        (marker === "demo" || marker === "cover" || !hasMarker(album, marker))),
    );
  });

  const synced = filtered.filter(
    (item): item is Candidate & { syncedLyrics: string } =>
      typeof item.syncedLyrics === "string" &&
      item.syncedLyrics.trim().length > 0 &&
      lengthMatches(item, durationMs),
  );
  for (const candidate of rank(synced, durationMs, markers)) {
    const lines = parseLrc((candidate.item as Candidate & { syncedLyrics: string }).syncedLyrics);
    if (lines.some((line) => line.text.length > 0)) return { lines, plain: "" };
  }

  const plain = filtered.filter(
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
  artist = "",
): LyricLine[] | null {
  const sheet = pickSheet(candidates, durationMs, title, artist);
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
  const clean = normalizeLyricsQuery(cleanTrackTitle(title));
  const cleanArtist = normalizeLyricsQuery(artist);
  if (!clean || !cleanArtist) return null;
  const albumPart = album?.trim().toLowerCase() ?? "";
  const key = `${clean.toLowerCase()}|${cleanArtist.toLowerCase()}|${albumPart}|${Math.round(durationMs / 1000)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Lyrics request timed out", "TimeoutError")), TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort, { once: true });

  let exactSheet: LyricsSheet | null = null;
  try {
    let query = `?track_name=${encodeURIComponent(clean)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    if (album?.trim()) {
      query += `&album_name=${encodeURIComponent(album.trim())}`;
    }
    if (durationMs > 0) {
      query += `&duration=${Math.round(durationMs / 1000)}`;
    }
    // An exact answer with timestamps settles it. An exact answer with plain
    // words is kept as a fallback while the search looks for a timed version
    // of the same recording, rather than giving up on sync too early.
    const exact = await request(`/get${query}`, timeout.signal);
    signal?.throwIfAborted();
    if (exact.ok) {
      const body = (await exact.json()) as Candidate;
      signal?.throwIfAborted();
      exactSheet = pickSheet([body], durationMs, title, artist);
      if (exactSheet && exactSheet.lines.length > 0) {
        remember(key, exactSheet);
        return exactSheet;
      }
    }

    // Album metadata often names a compilation/reissue. Search the song and
    // artist independently, then validate performance and duration locally.
    // This follows boring.notch's structured LRCLIB search instead of requiring
    // the album text to occur in the service's full-text index.
    const search = await request(
      `/search?track_name=${encodeURIComponent(clean)}&artist_name=${encodeURIComponent(cleanArtist)}`,
      timeout.signal,
    );
    signal?.throwIfAborted();
    if (search.ok) {
      const body = (await search.json()) as Candidate[];
      signal?.throwIfAborted();
      const found = Array.isArray(body) ? pickSheet(body, durationMs, title, artist) : null;
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
  } catch (error) {
    // Changing tracks cancels the whole lookup; a service/search failure does not
    // invalidate the already verified exact plain lyrics. Leave failures retryable.
    signal?.throwIfAborted();
    if (exactSheet) return exactSheet;
    throw error;
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
