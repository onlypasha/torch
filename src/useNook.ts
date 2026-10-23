import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { keepArtwork } from "./media";
import type { MediaCommand, MediaState } from "./media";
import {
  LYRIC_LINES,
  LYRIC_SOURCE_AVAILABLE,
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

export type NookModel = {
  media: MediaState;
  mediaControl: (action: MediaCommand) => void;
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
  lyricIndex: number;
};

export function useNook(): NookModel {
  const [media, setMedia] = useState<MediaState>(null);
  const artwork = useRef<NonNullable<MediaState> | null>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<MediaState>("media-state", (event) => {
      const merged = keepArtwork(artwork.current, event.payload);
      artwork.current = merged;
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

  const mediaControl = useCallback((action: MediaCommand) => {
    void invoke("media_control", { action }).catch((error) => {
      console.error("media_control failed:", error);
    });
  }, []);

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

  const [lyricIndex, setLyricIndex] = useState(0);
  const playing = media?.playing === true;
  useEffect(() => {
    if (!playing || !LYRIC_SOURCE_AVAILABLE) return;
    const id = window.setInterval(() => setLyricIndex((index) => (index + 1) % LYRIC_LINES.length), 2500);
    return () => window.clearInterval(id);
  }, [playing]);

  return {
    media,
    mediaControl,
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
    lyricIndex,
  };
}
