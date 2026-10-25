import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mergeMediaState, nextPlayheadAnchor, playheadAt, seekSettled, seekTarget } from "./media";
import type { MediaCommand, MediaState, PlayheadAnchor, SeekOutcome } from "./media";
import { fetchLyrics, lyricWindow } from "./lyrics";
import type { LyricLine, LyricsState, LyricsStatus } from "./lyrics";
import {
  pinVerdict,
  pinWidget,
  pomodoroPhase,
  rotate,
  stackWidgets,
  swapPinned,
  unpinWidget,
  WIDGETS,
} from "./nook";
import type { PinVerdict, PomodoroPhase, WidgetId } from "./nook";
import { initialPomodoro, pomodoroReducer } from "./pomodoro";
import type { PomodoroState } from "./pomodoro";

/**
 * App owns this model for its whole lifetime, like WPF's retained controls.
 * Tabs and panel views can unmount without resetting timers, widgets or pins.
 * This is session state, not persistence across application restarts.
 */

/** How long a seek may hold the bar before the player's own position wins. */
const SEEK_HOLD_MS = 3000;

export type NookModel = {
  media: MediaState;
  /** Where the bar is drawn: the player's position, or a seek in flight. */
  positionMs: number;
  mediaControl: (action: MediaCommand) => void;
  beginSeek: () => void;
  previewSeek: (ratio: number) => void;
  commitSeek: (ratio: number) => void;
  seekFailed: boolean;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  stack: WidgetId[];
  active: WidgetId;
  step: (delta: 1 | -1) => void;
  select: (widget: WidgetId) => void;
  pinned: WidgetId[];
  verdict: (widget: WidgetId) => PinVerdict;
  pin: (widget: WidgetId) => void;
  unpin: (widget: WidgetId) => void;
  movePin: (from: number, to: number) => void;
  pomodoro: PomodoroState;
  pomodoroPhase: PomodoroPhase;
  togglePomodoro: () => void;
  resetPomodoro: () => void;
  cyclePomodoroMode: () => void;
  lyrics: LyricsState;
  lyricRow: { previous: string; current: string; next: string };
};

export function useNook(open: boolean): NookModel {
  const [media, setMedia] = useState<MediaState>(null);
  const artwork = useRef<NonNullable<MediaState> | null>(null);

  // Keep the lightweight media listener alive, but poll rapidly only while
  // Nook is visible. Other tabs and the closed bar use the passive cadence.
  useEffect(() => {
    void invoke("media_polling", { active: open }).catch(() => {});
    if (open) void invoke("media_snapshot").catch(() => {});
    return () => {
      void invoke("media_polling", { active: false }).catch(() => {});
    };
  }, [open]);

  const [seekPending, setSeekPending] = useState<number | null>(null);
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const [seekFailed, setSeekFailed] = useState(false);
  const pendingRef = useRef<{ targetMs: number; at: number } | null>(null);

  // A panel can disappear during a drag. Keep real playback/requests, not an
  // abandoned preview that would otherwise cover the timeline on reopening.
  useEffect(() => {
    if (!open) setSeekPreviewMs(null);
  }, [open]);

  // Local monotonic playhead clock: interpolates between GSMTC polls so lyrics and
  // progress move in real-time and do not freeze if Windows sends infrequent updates.
  const [localClockMs, setLocalClockMs] = useState(0);
  const anchorRef = useRef<PlayheadAnchor>({
    baseMs: 0,
    at: performance.now(),
    playing: false,
    durationMs: 0,
    trackKey: "",
    playbackRate: 1.0,
  });

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<MediaState>("media-state", (event) => {
      const merged = mergeMediaState(artwork.current, event.payload);
      artwork.current = merged;

      const pending = pendingRef.current;
      if (pending) {
        const near = merged ? seekSettled(pending.targetMs, merged.positionMs) : true;
        if (near || performance.now() - pending.at > SEEK_HOLD_MS) {
          pendingRef.current = null;
          setSeekPending(null);
        }
      }
      setMedia(merged);

      if (merged) {
        const now = performance.now();
        // The source wins on every update, with the single stale-zero guard
        // documented on `nextPlayheadAnchor`.
        const anchor = nextPlayheadAnchor(anchorRef.current, merged, now);
        anchorRef.current = anchor;
        setLocalClockMs(Math.round(playheadAt(anchor, now)));
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // Paint the clock from the anchor every frame while the panel is open. The
  // loop never stops early: a pause or a source-side seek changes the anchor,
  // and the next frame must pick that up instead of freezing on old state.
  useEffect(() => {
    if (!open) return;
    let animId: number;
    let lastPaintMs = -1;
    let lastPaintAt = 0;

    const frame = (at: number) => {
      // 30 updates a second is smoother than the WPF ticker and still keeps the
      // words and the bar within a frame of the player's clock.
      if (at - lastPaintAt >= 33) {
        lastPaintAt = at;
        const rounded = Math.round(playheadAt(anchorRef.current, at));
        if (rounded !== lastPaintMs) {
          lastPaintMs = rounded;
          setLocalClockMs(rounded);
        }
      }
      animId = requestAnimationFrame(frame);
    };

    animId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animId);
  }, [open]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<SeekOutcome>("media-seek", (event) => {
      // Whatever the player answered, the preview must not stay on screen once
      // the worker has finished verifying: a rejected seek snaps back.
      pendingRef.current = null;
      setSeekPending(null);
      setSeekPreviewMs(null);
      setSeekFailed(!event.payload.applied);
      if (event.payload.applied) {
        // Hold the verified position until the next timeline sample arrives,
        // like the WPF commit does, so the bar does not flash the old spot.
        anchorRef.current = {
          ...anchorRef.current,
          baseMs: event.payload.positionMs,
          at: performance.now(),
        };
        setLocalClockMs(event.payload.positionMs);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const mediaControl = useCallback((action: MediaCommand) => {
    void invoke("media_control", { action }).catch((error) => {
      console.error("media_control failed:", error);
    });
  }, []);

  const beginSeek = useCallback(() => {
    setSeekFailed(false);
  }, []);

  const previewSeek = useCallback((ratio: number) => {
    setSeekPreviewMs((current) => {
      // The duration lives on the last media payload; the component passes a
      // ratio, so the target is resolved here against the freshest state.
      const duration = artwork.current?.durationMs ?? 0;
      if (duration <= 0) return current;
      return seekTarget(ratio, duration);
    });
  }, []);

  const commitSeek = useCallback((ratio: number) => {
    const duration = artwork.current?.durationMs ?? 0;
    setSeekPreviewMs(null);
    if (duration <= 0) return;
    const targetMs = seekTarget(ratio, duration);
    pendingRef.current = { targetMs, at: performance.now() };
    setSeekPending(targetMs);
    setSeekFailed(false);
    void invoke("media_seek", { positionMs: targetMs }).catch((error) => {
      console.error("media_seek failed:", error);
      pendingRef.current = null;
      setSeekPending(null);
      setSeekFailed(true);
    });
  }, []);

  const toggleShuffle = useCallback(() => {
    const active = artwork.current?.shuffle === true;
    void invoke("media_shuffle", { active: !active }).catch((error) => {
      console.error("media_shuffle failed:", error);
    });
  }, []);

  const cycleRepeat = useCallback(() => {
    void invoke("media_repeat").catch((error) => {
      console.error("media_repeat failed:", error);
    });
  }, []);

  // A rejected seek stops being an error as soon as the user tries again.
  useEffect(() => {
    if (!seekFailed) return;
    const timer = window.setTimeout(() => setSeekFailed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [seekFailed]);

  // -------------------------------------------------------------------------
  // Stack and pins
  // -------------------------------------------------------------------------

  const [active, setActive] = useState<WidgetId>(WIDGETS[0]);
  const [pinned, setPinned] = useState<WidgetId[]>([]);
  const stack = stackWidgets(pinned);
  // A pinned widget cannot stay active in the stack; fall back to the head.
  const activeWidget = stack.includes(active) ? active : stack[0];

  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const activeRef = useRef(activeWidget);
  activeRef.current = activeWidget;

  const step = useCallback((delta: 1 | -1) => {
    const list = stackWidgets(pinnedRef.current);
    setActive(rotate(list, activeRef.current, delta));
  }, []);

  const select = useCallback((widget: WidgetId) => {
    if (stackWidgets(pinnedRef.current).includes(widget)) setActive(widget);
  }, []);

  const verdict = useCallback(
    (widget: WidgetId) => pinVerdict(pinnedRef.current, widget),
    [],
  );
  const pin = useCallback(
    (widget: WidgetId) => setPinned((current) => pinWidget(current, widget)),
    [],
  );
  const unpin = useCallback(
    (widget: WidgetId) => setPinned((current) => unpinWidget(current, widget)),
    [],
  );
  const movePin = useCallback(
    (from: number, to: number) => setPinned((current) => swapPinned(current, from, to)),
    [],
  );

  // -------------------------------------------------------------------------
  // Pomodoro
  // -------------------------------------------------------------------------

  const [pomodoro, dispatchPomodoro] = useReducer(pomodoroReducer, undefined, () => initialPomodoro());

  // Deadline-based ticking: switching tabs (or a slow frame) can never make the
  // timer drift, it always recomputes from the wall clock.
  useEffect(() => {
    if (!pomodoro.running && pomodoro.feedbackUntil === null) return;
    const tick = () => dispatchPomodoro({ type: "tick", now: Date.now() });
    tick();
    const id = window.setInterval(tick, 250);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pomodoro.running, pomodoro.feedbackUntil]);

  const togglePomodoro = useCallback(() => {
    dispatchPomodoro({ type: "toggle", now: Date.now() });
  }, []);

  const resetPomodoro = useCallback(() => {
    dispatchPomodoro({ type: "reset" });
  }, []);

  const cyclePomodoroMode = useCallback(() => dispatchPomodoro({ type: "next-mode" }), []);

  // -------------------------------------------------------------------------
  // Lyrics
  // -------------------------------------------------------------------------

  const [lyricStatus, setLyricStatus] = useState<LyricsStatus>("idle");
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  // Position/artwork polls create new media objects. Only a change of song may
  // cancel the sheet being fetched, not the next playback tick.
  const lyricTitle = media?.title.trim() ?? "";
  const lyricArtist = media?.artist.trim() ?? "";
  const lyricAlbum = media?.album.trim() ?? "";
  const lyricDuration = Math.round((media?.durationMs ?? 0) / 1000);
  const hasMedia = media !== null;

  const positionMs = useMemo(() => {
    if (seekPreviewMs !== null) return seekPreviewMs;
    if (seekPending !== null) return seekPending;
    return localClockMs;
  }, [localClockMs, seekPending, seekPreviewMs]);

  // Track identity for lyrics: do not trigger re-fetches if duration momentarily drops
  const currentSongKey = useMemo(() => {
    if (!hasMedia || !lyricTitle || !lyricArtist) return "";
    return `${lyricTitle}\n${lyricArtist}\n${lyricAlbum}`;
  }, [hasMedia, lyricTitle, lyricArtist, lyricAlbum]);

  useEffect(() => {
    if (!hasMedia) {
      setLyricStatus("idle");
      setLyricLines([]);
      return;
    }
    if (!lyricTitle || !lyricArtist) {
      setLyricStatus("unavailable");
      setLyricLines([]);
      return;
    }
    const controller = new AbortController();
    setLyricStatus("loading");
    setLyricLines([]);
    void fetchLyrics({
      title: lyricTitle,
      artist: lyricArtist,
      album: lyricAlbum,
      durationMs: lyricDuration * 1000,
      signal: controller.signal,
    })
      .then((lines) => {
        if (controller.signal.aborted) return;
        if (lines && lines.length > 0) {
          setLyricLines(lines);
          setLyricStatus("ready");
        } else {
          setLyricStatus("unavailable");
        }
      })
      .catch(() => {
        // Only our cleanup (song change/unmount) is silent. A service timeout
        // can also throw AbortError, but must leave the loading state.
        if (controller.signal.aborted) return;
        setLyricStatus("failed");
      });
    return () => controller.abort();
  }, [currentSongKey]);

  // The row follows the displayed position, which includes a seek preview, so
  // the words move with the thumb instead of waiting for the player's answer.
  // No lead or manual offset: the words sit exactly on the player's timeline.
  const lyricRow = useMemo(
    () => lyricWindow(lyricLines, positionMs),
    [lyricLines, positionMs],
  );

  return {
    media,
    positionMs,
    mediaControl,
    beginSeek,
    previewSeek,
    commitSeek,
    seekFailed,
    toggleShuffle,
    cycleRepeat,
    stack,
    active: activeWidget,
    step,
    select,
    pinned,
    verdict,
    pin,
    unpin,
    movePin,
    pomodoro,
    pomodoroPhase: pomodoroPhase(pomodoro.running, pomodoro.finished),
    togglePomodoro,
    resetPomodoro,
    cyclePomodoroMode,
    lyrics: { status: lyricStatus, lines: lyricLines },
    lyricRow: { previous: lyricRow.previous, current: lyricRow.current, next: lyricRow.next },
  };
}
