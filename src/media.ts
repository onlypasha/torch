/**
 * What the native media worker emits. `null` means Windows has no session at
 * all, which the panel shows as "Tidak ada media" rather than as an empty song.
 */
export type MediaState = {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  thumbnail?: string;
  canPrevious: boolean;
  canNext: boolean;
  canToggle: boolean;
  source: string;
} | null;

export type MediaCommand = "previous" | "toggle" | "next";

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

/**
 * The worker sends album art only when the track changes, because the data URL
 * dwarfs the rest of the payload. Keep the previous image while the title and
 * artist match, and drop it the moment they don't.
 */
export function keepArtwork<T extends { title: string; artist: string; thumbnail?: string }>(
  previous: T | null,
  next: T | null,
): T | null {
  if (!next) return null;
  if (next.thumbnail) return next;
  if (
    previous?.thumbnail &&
    previous.title === next.title &&
    previous.artist === next.artist
  ) {
    return { ...next, thumbnail: previous.thumbnail };
  }
  return next;
}

/** Windows' own transport state, as the panel's two icon states. */
export const isPlaying = (media: MediaState): boolean => media?.playing === true;

/** A session can exist while a player is stopped; the panel still shows it. */
export function mediaCaption(media: MediaState): { title: string; artist: string } {
  if (!media) return { title: "Tidak ada media", artist: "" };
  const album = media.album.trim();
  const title = media.title.trim() || album || "Media";
  // Avoid repeating the album as both lines; the app name is more useful
  // than an empty second line, and says where the sound comes from.
  const artist = media.artist.trim() || (album && album !== title ? album : "") || media.source.split(/[\\/]/).at(-1) || "";
  return { title, artist };
}
