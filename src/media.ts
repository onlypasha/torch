/**
 * What the native media worker emits. `null` means Windows has no session at
 * all, which the panel shows as "Tidak ada media" rather than as an empty song.
 */
export type MediaRepeat = "none" | "list" | "track";

export type MediaState = {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  hasTimeline: boolean;
  thumbnail?: string;
  canPrevious: boolean;
  canNext: boolean;
  canToggle: boolean;
  canSeek: boolean;
  shuffle: boolean;
  shuffleSupported: boolean;
  repeat: MediaRepeat;
  repeatSupported: boolean;
  source: string;
  /** Windows' publication stamp for this timeline sample. */
  timelineUpdatedMs?: number;
  playbackRate?: number;
  /** Epoch millis when the worker measured `positionMs`. */
  sampledAtMs?: number;
} | null;

export type MediaCommand = "previous" | "toggle" | "next";

/** What the worker reports after it has verified a seek with the player. */
export type SeekOutcome = {
  applied: boolean;
  positionMs: number;
  /** Echo of our request id, so a late answer for another drag is ignored. */
  token?: number;
  /** Epoch millis when the worker read `positionMs`. */
  sampledAtMs?: number;
  /** `track-changed` or `no-session` when nothing was sent at all. */
  rejected?: string;
};

/**
 * Everything that has to match for two payloads to describe the same thing:
 * the app, not just the metadata. Two players can show the same song, and a
 * leftover cover or seek confirmation from one must not land on the other.
 */
export function trackIdentity(media: {
  title: string;
  artist: string;
  album: string;
  source: string;
}): string {
  return [media.source, media.title, media.artist, media.album].join("\u0000");
}

/** `m:ss`, or `h:mm:ss` for the rare long track. */
export function mediaTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const tail = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${tail.padStart(5, "0")}` : tail;
}

/** 0–100 for the progress fill; a track with no known length stays at 0. */
export function mediaPercent(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (positionMs / durationMs) * 100));
}

/** Where a pointer at `ratio` of the bar lands, in milliseconds. */
export function seekTarget(ratio: number, durationMs: number): number {
  if (!Number.isFinite(ratio) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, ratio)) * durationMs);
}

/** Pointer position inside the bar as a 0–1 ratio, clamped at both ends. */
export function seekRatio(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/**
 * Merges previous and next state, preserving thumbnail, duration, and position
 * if Windows reports a momentary dropout for the same song.
 */
export function mergeMediaState(
  previous: MediaState,
  next: MediaState,
): MediaState {
  if (!next) return null;
  if (!previous) return next;

  const sameSong =
    previous.title === next.title &&
    previous.artist === next.artist &&
    previous.album === next.album &&
    previous.source === next.source;

  if (!sameSong) return next;

  const merged = { ...next };

  // Retain thumbnail
  if (!merged.thumbnail && previous.thumbnail) {
    merged.thumbnail = previous.thumbnail;
  }

  // If incoming timeline dropped to zero but previous had valid timeline, preserve previous
  if (merged.durationMs <= 0 && previous.durationMs > 0) {
    merged.durationMs = previous.durationMs;
    merged.hasTimeline = previous.hasTimeline;
    merged.canSeek = previous.canSeek;
    if (merged.positionMs <= 0 && previous.positionMs > 0) {
      merged.positionMs = previous.positionMs;
      // The retained position was measured with the old sample, so keep its
      // clock too; a fresh `sampledAtMs` would age the wrong number.
      merged.sampledAtMs = previous.sampledAtMs;
      merged.timelineUpdatedMs = previous.timelineUpdatedMs;
    }
  }

  return merged;
}

/**
 * The one clock the progress bar and the lyrics both follow.
 *
 * The native worker projects Windows' timeline through its own
 * `LastUpdatedTime`, so every sample already describes "now". The source is
 * therefore adopted as-is on each update - exactly what the WPF original does
 * in `ApplyMedia` - instead of being smoothed or held back. The sole exception
 * is a zeroed timeline for the same playing track, which background web
 * players sometimes publish while their audio keeps going; accepting it would
 * rewind the bar and the words to the start.
 */
export type PlayheadAnchor = {
  baseMs: number;
  /** `performance.now()` when `baseMs` was measured. */
  at: number;
  playing: boolean;
  durationMs: number;
  trackKey: string;
  playbackRate: number;
  /**
   * Windows' publication stamp adopted with `baseMs`. A newer publication is
   * news - a seek, a repeat, a fresh sample - and outranks the zero guard.
   */
  sampleStampMs: number | null;
};

/**
 * How much flight time may be added to a payload before it is treated as a
 * clock problem rather than latency. Beyond this the next poll is closer.
 */
export const MAX_SAMPLE_AGE_MS = 2_000;

/** Where a payload's own sample stands now, after its trip through IPC. */
export function projectSample(
  media: NonNullable<MediaState>,
  receivedAtMs: number,
): number {
  const rate = media.playbackRate && media.playbackRate > 0 ? media.playbackRate : 1;
  const age = media.sampledAtMs
    ? Math.min(MAX_SAMPLE_AGE_MS, Math.max(0, receivedAtMs - media.sampledAtMs))
    : 0;
  const projected = media.positionMs + (media.playing ? age * rate : 0);
  return media.durationMs > 0 ? Math.min(media.durationMs, projected) : projected;
}

export function nextPlayheadAnchor(
  previous: PlayheadAnchor,
  media: NonNullable<MediaState>,
  now: number,
  receivedAtMs: number = Date.now(),
): PlayheadAnchor {
  const trackKey = trackIdentity(media);
  const sameTrack = previous.trackKey === trackKey && previous.durationMs > 0;
  const playbackRate = media.playbackRate && media.playbackRate > 0 ? media.playbackRate : 1;
  const stamp = media.timelineUpdatedMs ?? null;
  const newerPublication =
    stamp !== null && previous.sampleStampMs !== null && stamp > previous.sampleStampMs;

  // Background web players sometimes publish a zeroed timeline while their
  // audio keeps going. Only an *unchanged* publication can be that bogus zero:
  // a repeat, a seek to the start or a fresh sample is real news.
  const staleZero =
    sameTrack &&
    previous.playing &&
    media.playing &&
    media.positionMs === 0 &&
    previous.baseMs > 0 &&
    !newerPublication;

  return {
    baseMs: staleZero ? previous.baseMs : projectSample(media, receivedAtMs),
    at: staleZero ? previous.at : now,
    playing: media.playing,
    durationMs: media.durationMs,
    trackKey,
    playbackRate,
    sampleStampMs: staleZero ? previous.sampleStampMs : stamp,
  };
}

/** Where the anchor puts the playhead at `now`, respecting rate and length. */
export function playheadAt(anchor: PlayheadAnchor, now: number): number {
  const elapsed = anchor.playing ? Math.max(0, now - anchor.at) * anchor.playbackRate : 0;
  const projected = anchor.baseMs + elapsed;
  return anchor.durationMs > 0 ? Math.min(anchor.durationMs, projected) : projected;
}

/**
 * The worker sends album art only when the track changes or when the panel
 * opens, because the data URL dwarfs the rest of the payload. Keep the
 * previous image while the app and the title, artist and album match, and drop
 * it the moment they don't.
 */
export function keepArtwork<T extends {
  title: string;
  artist: string;
  album: string;
  source: string;
  thumbnail?: string;
}>(
  previous: T | null,
  next: T | null,
): T | null {
  if (!next) return null;
  if (next.thumbnail) return next;
  if (
    previous?.thumbnail &&
    previous.title === next.title &&
    previous.artist === next.artist &&
    previous.album === next.album &&
    previous.source === next.source
  ) {
    return { ...next, thumbnail: previous.thumbnail };
  }
  return next;
}

/** Windows' own transport state, as the panel's two icon states. */
export const isPlaying = (media: MediaState): boolean => media?.playing === true;

/** A readable app name from an executable name or a packaged-app AUMID. */
export function appName(source: string): string {
  const tail = source.split(/[\\/]/).at(-1) ?? "";
  // Packaged apps report `Publisher.App_hash!EntryPoint`; the entry point is
  // the recognisable part, and its last dotted segment the readable name.
  const entry = tail.includes("!") ? (tail.split("!").at(-1) ?? "") : tail;
  const bare = entry.replace(/\.exe$/i, "");
  return bare.split(".").at(-1) || bare;
}

/** A session can exist while a player is stopped; the panel still shows it. */
export function mediaCaption(media: MediaState): {
  title: string;
  artist: string;
  album: string;
} {
  if (!media) return { title: "Tidak ada media", artist: "", album: "" };
  const album = media.album.trim();
  const title = media.title.trim() || album || "Media";
  // Avoid repeating the album as both lines; the app name is more useful
  // than an empty second line, and says where the sound comes from.
  const artist = media.artist.trim() || appName(media.source);
  return { title, artist, album: album === title ? "" : album };
}

export const REPEAT_LABEL: Record<MediaRepeat, string> = {
  none: "Repeat mati",
  list: "Repeat semua",
  track: "Repeat satu",
};

export const REPEAT_BADGE: Record<MediaRepeat, string> = {
  none: "",
  list: "Semua",
  track: "Satu",
};

/** Off -> all -> one -> off, the order every player's repeat button uses. */
export function nextRepeat(mode: MediaRepeat): MediaRepeat {
  return mode === "none" ? "list" : mode === "list" ? "track" : "none";
}

/**
 * A seek is optimistic: the bar jumps to the target immediately and holds
 * there until the player confirms it, because a poll in between would drag the
 * thumb back to the old position and make the drag look ignored.
 */
export function seekSettled(targetMs: number, incomingMs: number): boolean {
  return Math.abs(incomingMs - targetMs) < 1500;
}
