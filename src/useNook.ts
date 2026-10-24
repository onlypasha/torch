import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { keepArtwork, seekSettled, seekTarget } from "./media";
import type { MediaCommand, MediaState, SeekOutcome } from "./media";
import { fetchLyrics, lyricWindow } from "./lyrics";
import type { LyricLine, LyricsState, LyricsStatus } from "./lyrics";
import {
  POMODORO_SECONDS,
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

/**
 * Nook state lives in the panel, not in the tab body, so switching to Tray and
 * back does not restart the song, the Pomodoro, the lyric or the pin column.
 * Nothing is written to disk: the state's lifetime is the open panel, which is
 * what the spec asked for ("bertahan antar tab").
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
  pomodoro: { remaining: number; running: boolean; finished: boolean };
  pomodoroPhase: PomodoroPhase;
  togglePomodoro: () => void;
  resetPomodoro: () => void;
  lyrics: LyricsState;
  lyricRow: { previous: string; current: string; next: string };
};

export function useNook(): NookModel {
  const [media, setMedia] = useState<MediaState>(null);
  const artwork = useRef<NonNullable<MediaState> | null>(null);

  // The panel is mounted only while it is open, so this is exactly the moment
  // the native worker should switch to its fast poll (and back off when the
  // notch closes and only the collapsed badge needs the state).
  useEffect(() => {
    void invoke("media_polling", { active: true }).catch(() => {});
    void invoke("media_snapshot").catch(() => {});
    return () => {
      void invoke("media_polling", { active: false }).catch(() => {});
    };
  }, []);

  const [seekPending, setSeekPending] = useState<number | null>(null);
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const [seekFailed, setSeekFailed] = useState(false);
  const pendingRef = useRef<{ targetMs: number; at: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<MediaState>("media-state", (event) => {
      const merged = keepArtwork(artwork.current, event.payload);
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
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

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

  const [pomodoro, setPomodoro] = useState({
    remaining: POMODORO_SECONDS,
    running: false,
    finished: false,
  });
  const pomodoroRef = useRef(pomodoro);
  pomodoroRef.current = pomodoro;
  const deadline = useRef(0);

  // Deadline-based ticking: switching tabs (or a slow frame) can never make the
  // timer drift, it always recomputes from the wall clock.
  useEffect(() => {
    if (!pomodoro.running) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setPomodoro((current) => {
        if (left <= 0) {
          return current.finished ? current : { remaining: 0, running: false, finished: true };
        }
        return current.remaining === left ? current : { ...current, remaining: left };
      });
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [pomodoro.running]);

  const togglePomodoro = useCallback(() => {
    const current = pomodoroRef.current;
    if (current.finished) {
      deadline.current = Date.now() + POMODORO_SECONDS * 1000;
      setPomodoro({ remaining: POMODORO_SECONDS, running: true, finished: false });
      return;
    }
    if (current.running) {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setPomodoro({ remaining: left, running: false, finished: false });
      return;
    }
    deadline.current = Date.now() + current.remaining * 1000;
    setPomodoro((timer) => ({ ...timer, running: true }));
  }, []);

  const resetPomodoro = useCallback(() => {
    setPomodoro({ remaining: POMODORO_SECONDS, running: false, finished: false });
  }, []);

  // -------------------------------------------------------------------------
  // Lyrics
  // -------------------------------------------------------------------------

  const [lyricStatus, setLyricStatus] = useState<LyricsStatus>("idle");
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([]);
  const lyricKey = useRef("");

  const positionMs = useMemo(() => {
    if (seekPreviewMs !== null) return seekPreviewMs;
    if (seekPending !== null) return seekPending;
    return media?.positionMs ?? 0;
  }, [media?.positionMs, seekPending, seekPreviewMs]);

  useEffect(() => {
    if (!media) {
      lyricKey.current = "";
      setLyricStatus("idle");
      setLyricLines([]);
      return;
    }
    const title = media.title.trim();
    const artist = media.artist.trim();
    if (!title || !artist) {
      setLyricStatus("unavailable");
      setLyricLines([]);
      return;
    }
    const key = `${title}\u0000${artist}\u0000${Math.round(media.durationMs / 1000)}`;
    if (key === lyricKey.current) return;
    lyricKey.current = key;

    const controller = new AbortController();
    setLyricStatus("loading");
    setLyricLines([]);
    void fetchLyrics({
      title,
      artist,
      durationMs: media.durationMs,
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
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // An aborted request is not a failure the user should read about.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLyricStatus("failed");
      });
    return () => controller.abort();
  }, [media]);

  // The row follows the displayed position, which includes a seek preview, so
  // the words move with the thumb instead of waiting for the player's answer.
  const lyricRow = useMemo(() => lyricWindow(lyricLines, positionMs), [lyricLines, positionMs]);

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
    lyrics: { status: lyricStatus, lines: lyricLines },
    lyricRow: { previous: lyricRow.previous, current: lyricRow.current, next: lyricRow.next },
  };
}
