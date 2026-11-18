import { useCallback, useEffect, useRef, useState } from "react";
import { runtimeConfig } from "./config";
import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { PanInfo, Transition } from "framer-motion";
import { mediaCaption, mediaPercent, mediaTime, seekRatio, seekTarget, trackIdentity, REPEAT_LABEL } from "./media";
import { LYRIC_FAILED, LYRIC_LOADING, LYRIC_UNAVAILABLE } from "./lyrics";
import {
  compactMonth,
  pomodoroClock,
  pomodoroFraction,
  STACK_POSITION,
  stackOffset,
  stackSlot,
  weekdayLong,
  WIDGET_LABEL,
  WidgetWheelNavigator,
} from "./nook";
import type { PinVerdict, WidgetId } from "./nook";
import type { NookModel, SeekGesture } from "./useNook";
import { QuickSettingsWidget, SystemMonitorWidget } from "./QuickSettingsWidgets";
import { CalendarWidget } from "./CalendarWidget";
import { WeatherWidget } from "./WeatherWidget";
import "./NookWidgets.css";

/**
 * The Nook tab: fixed media panel, the rotating widget stack and (when any
 * widget is pinned) the compact column that widens the whole notch.
 *
 * The three parts never resize with the shell: the panel grows 640 -> 752 by
 * adding the pinned column beside them, so the stack keeps its full 252px.
 */

const STACK_SPRING: Transition = { type: "spring", stiffness: 400, damping: 40 };
const REORDER_SPRING: Transition = { type: "spring", stiffness: 500, damping: 36 };
const LYRIC_TRANSITION: Transition = { duration: 0.18, ease: "easeOut" };
const PIN_IN: Transition = { type: "spring", stiffness: 420, damping: 42 };
const PIN_OUT: Transition = { duration: 0.15 };

const MENU_WIDTH = 180;
const MENU_HEIGHT = 50;
const DRAG_DISTANCE = 36;
const DRAG_VELOCITY = 400;
/** Keyboard seek step, matching what a player's arrow keys do. */
const SEEK_STEP_MS = 5000;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const PREVIOUS = "M10.5 4 5 8l5.5 4M13 4v8";
const NEXT = "M5.5 4 11 8l-5.5 4M3 4v8";
const PLAY = "M6 3.8 12 8l-6 4.2Z";
const PAUSE = "M5.5 4v8M10.5 4v8";
const SHUFFLE = "M2.5 4.5h2l6.5 7h2M2.5 11.5h2l6.5-7h2M11.5 2.8 13.6 4.5l-2.1 1.7M11.5 9.8l2.1 1.7-2.1 1.7";
const REPEAT = "M4.2 6.3V5.6c0-.9.7-1.6 1.6-1.6h6.4M12.2 4 10.6 2.4M12.2 4l-1.6 1.6M11.8 9.7v.7c0 .9-.7 1.6-1.6 1.6H3.8M3.8 12l1.6 1.6M3.8 12l1.6-1.6";

function TransportIcon({
  path,
  filled = false,
  size = 16,
}: {
  path: string;
  filled?: boolean;
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      fill={filled ? "currentColor" : "none"}>
      <path d={path} />
    </svg>
  );
}

/**
 * Scrolling title, only when the text is wider than the space it was given.
 * CSS drives the movement so a long title costs one animation, not a React
 * render per frame; a short one stays perfectly still.
 */
function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const measure = () => {
      const outer = box.current;
      const content = inner.current;
      if (!outer || !content) return;
      const overflow = content.scrollWidth - outer.clientWidth;
      setShift(overflow > 2 ? overflow + 16 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [text]);

  const style = shift > 0
    ? ({
        "--marquee-shift": `-${shift}px`,
        "--marquee-duration": `${Math.max(3, shift / 26)}s`,
      } as CSSProperties)
    : undefined;

  return (
    <span ref={box} className={`notch-marquee ${className ?? ""}`} title={text}>
      <span ref={inner} className="notch-marquee-inner" data-scroll={shift > 0 ? "true" : "false"} style={style}>
        {text}
      </span>
    </span>
  );
}

/**
 * The progress bar, which is also the seek control. The preview is optimistic:
 * the thumb follows the pointer immediately and the player is only asked once,
 * on release, so dragging does not flood the session with seeks.
 */
function SeekBar({ nook }: { nook: NookModel }) {
  const { media, positionMs } = nook;
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ pointerId: number; gesture: SeekGesture } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const duration = media?.durationMs ?? 0;
  const canSeek = media?.canSeek === true && duration > 0;
  const percent = mediaPercent(positionMs, duration);
  const trackKey = media ? trackIdentity(media) : "";

  const releaseCapture = (pointerId: number) => {
    try {
      if (track.current?.hasPointerCapture(pointerId)) track.current.releasePointerCapture(pointerId);
    } catch {
      // The browser may already have released this pointer.
    }
  };

  const cancelDrag = useCallback(() => {
    const drag = dragging.current;
    if (!drag) return;
    dragging.current = null;
    nook.cancelSeek();
    releaseCapture(drag.pointerId);
    setHover(null);
  }, [nook.cancelSeek]);

  useEffect(() => () => cancelDrag(), [trackKey, duration, canSeek, cancelDrag]);

  useEffect(() => {
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, [cancelDrag]);

  const ratioAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return seekRatio(clientX, rect.left, rect.width);
  };

  const finish = (clientX: number, pointerId: number) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragging.current = null;
    if (canSeek && drag.gesture.trackKey === trackKey && drag.gesture.durationMs === duration) {
      nook.commitSeek(ratioAt(clientX), drag.gesture);
    } else {
      nook.cancelSeek();
    }
    releaseCapture(pointerId);
    setHover(null);
  };

  const step = (deltaMs: number) => {
    if (!canSeek) return;
    const target = Math.min(duration, Math.max(0, positionMs + deltaMs));
    nook.commitSeek(target / duration);
  };

  return (
    <div className="notch-media-progress">
      <div
        ref={track}
        className="notch-media-track"
        data-interactive={canSeek ? "true" : "false"}
        data-failed={nook.seekFailed ? "true" : "false"}
        role={canSeek ? "slider" : undefined}
        tabIndex={canSeek ? 0 : -1}
        aria-label="Posisi lagu"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(positionMs / 1000)}
        aria-valuetext={mediaTime(positionMs)}
        onPointerDown={(event) => {
          if (!canSeek || event.button !== 0 || dragging.current) return;
          const gesture = nook.beginSeek();
          if (!gesture) return;
          dragging.current = { pointerId: event.pointerId, gesture };
          // A capture on a pointer the browser no longer tracks throws; the
          // drag still works without it, so this must never break the handler.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* not capturable in this environment */
          }
          nook.previewSeek(ratioAt(event.clientX), gesture);
        }}
        onPointerMove={(event) => {
          const ratio = ratioAt(event.clientX);
          const drag = dragging.current;
          if (drag?.pointerId === event.pointerId) nook.previewSeek(ratio, drag.gesture);
          else if (canSeek) setHover(ratio);
        }}
        onPointerUp={(event) => finish(event.clientX, event.pointerId)}
        onPointerCancel={(event) => {
          if (dragging.current?.pointerId === event.pointerId) cancelDrag();
        }}
        onLostPointerCapture={(event) => {
          if (dragging.current?.pointerId === event.pointerId) cancelDrag();
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (!canSeek) return;
          if (event.key === "ArrowRight") {
            event.preventDefault();
            step(SEEK_STEP_MS);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            step(-SEEK_STEP_MS);
          } else if (event.key === "Home") {
            event.preventDefault();
            nook.commitSeek(0);
          } else if (event.key === "End") {
            event.preventDefault();
            nook.commitSeek(1);
          }
        }}
      >
        <span className="notch-media-fill" style={{ width: `${percent}%` }} />
        {hover !== null && canSeek && (
          <span className="notch-media-hover" style={{ left: `${hover * 100}%` }} aria-hidden="true">
            {mediaTime(seekTarget(hover, duration))}
          </span>
        )}
      </div>
      <span className="notch-media-times">
        <span>{mediaTime(positionMs)}</span>
        <span data-notice={nook.seekFailed ? "true" : undefined}>
          {nook.seekFailed ? "Seek ditolak" : mediaTime(duration)}
        </span>
      </span>
    </div>
  );
}

function MediaPanel({ nook }: { nook: NookModel }) {
  const { media } = nook;
  const caption = mediaCaption(media);
  const playing = media?.playing === true;

  // One line, exactly like the reference's lyric row under the artist. The
  // rotating lyric widget still exists for people who want context around the
  // current line; this one is the always-visible karaoke strip.
  const lyric = !media
    ? ""
    : nook.lyrics.status === "ready"
      ? nook.lyricRow.current
      : nook.lyrics.status === "plain"
        ? nook.lyrics.plain.replace(/\s*\n\s*/g, " ").trim() || LYRIC_UNAVAILABLE
        : lyricNotice(nook);

  return (
    <section
      className="notch-media"
      aria-label="Media"
      data-playing={playing ? "true" : "false"}
    >
      {/* The sleeve's own colours, blurred behind the card the way Boring
          Notch lights the notch from the album art. */}
      {media?.thumbnail && (
        <div
          className="notch-media-aura"
          style={{ backgroundImage: `url(${media.thumbnail})` }}
          aria-hidden="true"
        />
      )}

      <motion.div
        className="notch-media-cover"
        data-art={media?.thumbnail ? "true" : "false"}
        style={media?.thumbnail ? { backgroundImage: `url(${media.thumbnail})` } : undefined}
        aria-hidden="true"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: playing ? 1 : 0.94 }}
        transition={{ type: "spring", stiffness: 300, damping: 26 }}
      >
        {!media?.thumbnail && (
          <svg className="notch-media-note" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l10-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="16" cy="16" r="3" />
          </svg>
        )}
        <span className="notch-media-eq">
          {[0, 1, 2, 3].map((bar) => (
            <motion.span
              key={bar}
              className="notch-media-eq-bar"
              initial={false}
              animate={playing ? { scaleY: [0.3, 1, 0.45, 0.9, 0.3] } : { scaleY: 0.25 }}
              transition={
                playing
                  ? { duration: 1.1, delay: bar * 0.12, ease: "easeInOut", repeat: Infinity }
                  : { duration: 0.2 }
              }
            />
          ))}
        </span>
      </motion.div>

      <div className="notch-media-info">
        <div className="notch-media-meta">
          <Marquee text={caption.title} className="notch-media-title" />
          <Marquee text={caption.artist} className="notch-media-artist" />
        </div>

        <div className="notch-media-lyric" data-status={nook.lyrics.status} data-empty={lyric ? undefined : "true"}>
          <AnimatePresence mode="wait" initial={false}>
            {lyric && (
              <motion.span
                key={lyric}
                className="notch-media-lyric-line"
                title={lyric}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              >
                <Marquee text={lyric} />
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <SeekBar nook={nook} />

        <div className="notch-media-controls" data-wide={media?.shuffleSupported || media?.repeatSupported ? "true" : "false"}>
          {media?.shuffleSupported && (
            <motion.button
              type="button"
              className="notch-media-button notch-media-toggle"
              data-on={media.shuffle ? "true" : "false"}
              whileTap={{ scale: 0.85 }}
              onClick={nook.toggleShuffle}
              aria-pressed={media.shuffle}
              aria-label="Acak lagu"
              title={media.shuffle ? "Acak: aktif" : "Acak: mati"}
            >
              <TransportIcon path={SHUFFLE} size={14} />
            </motion.button>
          )}
          <motion.button
            type="button"
            className="notch-media-button"
            whileTap={{ scale: 0.85 }}
            disabled={!media?.canPrevious}
            onClick={() => nook.mediaControl("previous")}
            aria-label="Lagu sebelumnya"
          >
            <TransportIcon path={PREVIOUS} />
          </motion.button>
          <motion.button
            type="button"
            className="notch-media-button notch-media-play"
            whileTap={{ scale: 0.85 }}
            disabled={!media?.canToggle}
            onClick={() => nook.mediaControl("toggle")}
            aria-label={playing ? "Jeda" : "Putar"}
          >
            <TransportIcon path={playing ? PAUSE : PLAY} filled={!playing} size={19} />
          </motion.button>
          <motion.button
            type="button"
            className="notch-media-button"
            whileTap={{ scale: 0.85 }}
            disabled={!media?.canNext}
            onClick={() => nook.mediaControl("next")}
            aria-label="Lagu berikutnya"
          >
            <TransportIcon path={NEXT} />
          </motion.button>
          {media?.repeatSupported && (
            <motion.button
              type="button"
              className="notch-media-button notch-media-toggle"
              data-on={media.repeat !== "none" ? "true" : "false"}
              whileTap={{ scale: 0.85 }}
              onClick={nook.cycleRepeat}
              aria-label={REPEAT_LABEL[media.repeat]}
              title={REPEAT_LABEL[media.repeat]}
            >
              <TransportIcon path={REPEAT} size={14} />
              {media.repeat === "track" && <span className="notch-media-repeat-one">1</span>}
            </motion.button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Widget bodies
// ---------------------------------------------------------------------------

function PomodoroStack({ nook }: { nook: NookModel }) {
  const reducedMotion = useReducedMotion();
  const fraction = pomodoroFraction(nook.pomodoro.remaining, nook.pomodoro.mode.seconds);
  const phase = nook.pomodoroPhase;
  return (
    <div className="notch-pomodoro">
      <div className="notch-pomodoro-head">
        <span className="notch-pomodoro-mode-label">{nook.pomodoro.mode.label}</span>
        <button type="button" className="notch-pomodoro-mode" onClick={nook.cyclePomodoroMode}
          aria-label={`Ganti mode Pomodoro, saat ini ${nook.pomodoro.mode.label}, ${nook.pomodoro.mode.seconds / 60} menit`}
          title="Ganti mode: fokus, istirahat singkat, istirahat panjang">
          {nook.pomodoro.mode.seconds / 60} mnt
        </button>
      </div>
      <div className="notch-pomodoro-side">
        <span className="notch-pomodoro-time" data-phase={phase}>{pomodoroClock(nook.pomodoro.remaining)}</span>
        <div className="notch-pomodoro-actions">
          <motion.button
            type="button"
            className="notch-pill-light"
            whileTap={{ scale: reducedMotion ? 1 : 0.97 }}
            onClick={nook.togglePomodoro}
          >
            {phase === "running" ? "Jeda" : phase === "finished" ? "Ulangi" : "Mulai"}
          </motion.button>
          <motion.button
            type="button"
            className="notch-pill-ghost"
            aria-label="Reset Pomodoro"
            title="Reset Pomodoro"
            whileTap={{ scale: reducedMotion ? 1 : 0.97 }}
            onClick={nook.resetPomodoro}
          >
            <span aria-hidden="true">↺</span>
          </motion.button>
        </div>
      </div>
      <div className="notch-pomodoro-track" role="progressbar" aria-label="Waktu tersisa" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

/** What the lyric widget says when there are no timed words to show. */
function lyricNotice(nook: NookModel): string {
  if (nook.lyrics.status === "loading") return LYRIC_LOADING;
  if (nook.lyrics.status === "failed") return LYRIC_FAILED;
  return LYRIC_UNAVAILABLE;
}

function LyricRows({ nook }: { nook: NookModel }) {
  const reducedMotion = useReducedMotion();
  if (nook.lyrics.status === "plain") {
    return (
      <div className="notch-lyrics notch-lyrics-plain" data-status="plain">
        <span className="notch-lyric-plain-text">{nook.lyrics.plain}</span>
      </div>
    );
  }

  if (nook.lyrics.status !== "ready") {
    return (
      <div className="notch-lyrics">
        <motion.span
          className="notch-lyric-line"
          data-current="true"
          data-placeholder="true"
          data-status={nook.lyrics.status}
          initial={false}
          animate={{ opacity: 1 }}
        >
          {lyricNotice(nook)}
        </motion.span>
      </div>
    );
  }

  const rows = [
    { role: "previous", text: nook.lyricRow.previous, current: false },
    { role: "current", text: nook.lyricRow.current, current: true },
    { role: "next", text: nook.lyricRow.next, current: false },
  ];

  return (
    <div className="notch-lyrics">
      {rows.map((row) => (
        <div key={row.role} className="notch-lyric-slot" data-slot-role={row.role}>
          <AnimatePresence initial={false}>
            {row.text && (
              <motion.span
                key={row.text}
                className="notch-lyric-line"
                data-role={row.role}
                data-current={row.current ? "true" : "false"}
                title={row.text}
                initial={{ opacity: 0, y: reducedMotion ? 0 : 5 }}
                animate={{ opacity: row.current ? 1 : 0.8, y: 0 }}
                exit={{ opacity: 0, y: reducedMotion ? 0 : -5 }}
                transition={LYRIC_TRANSITION}
              >
                {row.text}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function WidgetBody({ widget, nook }: { widget: WidgetId; nook: NookModel }) {
  return (
    <div className="notch-widget" data-widget={widget}>
      {widget !== "calendar" && widget !== "quicksettings" && widget !== "pomodoro" && widget !== "weather" && <span className="notch-widget-label">{WIDGET_LABEL[widget]}</span>}
      {widget === "quicksettings" && <QuickSettingsWidget />}
      {widget === "sysmon" && <SystemMonitorWidget />}
      {widget === "calendar" && <CalendarWidget />}
      {widget === "pomodoro" && <PomodoroStack nook={nook} />}
      {widget === "lyric" && <LyricRows nook={nook} />}
      {widget === "weather" && <WeatherWidget weather={nook.weather} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

function WidgetStack({
  nook,
  onMenu,
}: {
  nook: NookModel;
  onMenu: (widget: WidgetId, target: HTMLElement) => void;
}) {
  const wheelNavigator = useRef(new WidgetWheelNavigator());
  const reducedMotion = useReducedMotion();
  const stack = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = stack.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !Number.isFinite(event.deltaY) || event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (event.target instanceof Element && event.target.closest(".notch-calendar-dates")) return;
      // WPF lets a nested ScrollViewer consume input until its directional
      // edge. Only then does wheel input advance the widget carousel.
      let element = event.target instanceof Element ? event.target : null;
      while (element && element !== host) {
        const overflow = getComputedStyle(element).overflowY;
        if ((overflow === "auto" || overflow === "scroll") && element.scrollHeight - element.clientHeight > 0.5) {
          const atTop = element.scrollTop <= 0.5;
          const atBottom = element.scrollTop >= element.scrollHeight - element.clientHeight - 0.5;
          if (event.deltaY < 0 ? !atTop : !atBottom) return;
        }
        element = element.parentElement;
      }
      event.preventDefault();
      event.stopPropagation();
      const direction = wheelNavigator.current.step(event.deltaY, event.deltaX, performance.now(), event.deltaMode);
      if (direction) nook.step(direction);
    };
    // React's wheel listener is passive. Use a non-passive capture listener so
    // handled input cannot also scroll the page, matching PreviewMouseWheel.
    host.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => host.removeEventListener("wheel", onWheel, true);
  }, [nook.step]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stack.current?.focus({ preventScroll: true });
      nook.step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      stack.current?.focus({ preventScroll: true });
      nook.step(-1);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      if (stack.current) onMenu(nook.active, stack.current);
    }
  };

  return (
    <div
      ref={stack}
      className="notch-stack"
      role="group"
      aria-label="Tumpukan widget"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        // The visible card's own handler opens the widget menu; anywhere else
        // on the stack opens it for the active widget as well.
        event.preventDefault();
        event.stopPropagation();
        if (stack.current) onMenu(nook.active, stack.current);
      }}
    >
      {nook.stack.map((widget) => {
        const slot = stackSlot(stackOffset(nook.stack, nook.active, widget), nook.stack.length);
        const active = slot === "active";
        return (
          <motion.div
            key={widget}
            className="notch-stack-card"
            data-widget={widget}
            data-slot={slot}
            inert={!active}
            aria-hidden={!active}
            style={{ zIndex: active ? 10 : slot === "next" ? 5 : 1 }}
            initial={false}
            animate={reducedMotion ? { y: 0, scale: 1, opacity: active ? 1 : 0 } : STACK_POSITION[slot]}
            transition={reducedMotion ? { duration: 0.12 } : STACK_SPRING}
            drag={active ? "y" : false}
            dragElastic={0.25}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragSnapToOrigin
            onDragEnd={(_, info) => {
              if (info.offset.y < -DRAG_DISTANCE || info.velocity.y < -DRAG_VELOCITY) nook.step(1);
              else if (info.offset.y > DRAG_DISTANCE || info.velocity.y > DRAG_VELOCITY) nook.step(-1);
            }}
            onContextMenu={
              active
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onMenu(widget, event.currentTarget);
                  }
                : undefined
            }
          >
            <WidgetBody widget={widget} nook={nook} />
          </motion.div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pinned column
// ---------------------------------------------------------------------------

const PIN_ICON = "M9 2c1.4 0 2.5 1.1 2.5 2.5v2.2l1.3 1.8v1.1H9.9V13L8 15l-.2-5.4H3.2V8.5L4.5 6.7V4.5C4.5 3.1 5.6 2 7 2Z";

function PinBadge() {
  return (
    <svg className="notch-pin-badge" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={PIN_ICON} />
    </svg>
  );
}

/**
 * The body of a pinned card. Only Calendar, Pomodoro and Weather can reach the
 * column (`PINNABLE_WIDGETS`); Pomodoro renders its own button, so this covers
 * the two plain bodies and returns nothing for anything else.
 */
function PinnedBody({ widget, nook }: { widget: WidgetId; nook: NookModel }) {
  const today = new Date();
  if (widget === "calendar") {
    return (
      <div className="notch-pin-calendar">
        <span className="notch-pin-big">{today.getDate()}</span>
        <div className="notch-pin-calendar-meta">
          <span className="notch-pin-month">{compactMonth(today)}</span>
          <span className="notch-pin-weekday">{weekdayLong(today)}</span>
        </div>
      </div>
    );
  }
  if (widget === "weather") {
    return <WeatherWidget weather={nook.weather} compact />;
  }
  return null;
}

function PinnedColumn({
  nook,
  onMenu,
}: {
  nook: NookModel;
  onMenu: (widget: WidgetId, target: HTMLElement) => void;
}) {
  const dragged = useRef(false);
  const reducedMotion = useReducedMotion();
  const suppressClick = useRef(0);

  const togglePinnedPomodoro = () => {
    if (performance.now() < suppressClick.current) return;
    nook.togglePomodoro();
  };

  return (
    <div className="notch-pinned" aria-label="Widget disematkan">
      <AnimatePresence>
        {nook.pinned.map((widget, index) => {
          const last = index === nook.pinned.length - 1;
          const common = {
            key: widget,
            className: `notch-pin-card${widget === "pomodoro" ? " notch-pin-pomodoro" : ""}`,
            "data-widget": widget,
            "data-draggable": nook.pinned.length > 1 ? "true" : "false",
            layout: true,
            // Reordering is only meaningful with two pins; a lone card stays put.
            drag: (nook.pinned.length > 1 ? "y" : false) as "y" | false,
            dragElastic: 0.25,
            dragConstraints: { top: 0, bottom: 0 },
            dragSnapToOrigin: true,
            whileDrag: { scale: reducedMotion ? 1 : 1.04, boxShadow: "0 10px 24px rgba(0,0,0,0.5)", zIndex: 20 },
            transition: reducedMotion ? { duration: 0.12 } : REORDER_SPRING,
            initial: { opacity: 0, x: reducedMotion ? 0 : 24, scale: reducedMotion ? 1 : 0.9 },
            animate: { opacity: 1, x: 0, scale: 1, transition: reducedMotion ? { duration: 0.12 } : PIN_IN },
            exit: { opacity: 0, x: reducedMotion ? 0 : 24, scale: reducedMotion ? 1 : 0.9, transition: PIN_OUT },
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault(); event.stopPropagation(); onMenu(widget, event.currentTarget as HTMLElement);
              }
            },
            onDragStart: () => { dragged.current = true; },
            onDragEnd: (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
              dragged.current = false;
              suppressClick.current = performance.now() + 120;
              if (info.offset.y > 30 && !last) nook.movePin(index, index + 1);
              else if (info.offset.y < -30 && index > 0) nook.movePin(index, index - 1);
            },
            onContextMenu: (event: React.MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              onMenu(widget, event.currentTarget as HTMLElement);
            },
          } as const;

          if (widget === "pomodoro") {
            return (
              <motion.button
                {...common}
                key={widget}
                type="button"
                aria-pressed={nook.pomodoro.running}
                aria-label="Pomodoro"
                whileTap={{ scale: reducedMotion ? 1 : 0.97 }}
                onClick={togglePinnedPomodoro}
                data-phase={nook.pomodoroPhase}
              >
                <span className="notch-pin-track" aria-hidden="true" />
                <span
                  className="notch-pin-progress"
                  aria-hidden="true"
                  style={{ "--fill": pomodoroFraction(nook.pomodoro.remaining, nook.pomodoro.mode.seconds) } as CSSProperties}
                />
                <PinBadge />
                <span className="notch-pin-time">{pomodoroClock(nook.pomodoro.remaining)}</span>
              </motion.button>
            );
          }

          return (
            <motion.div {...common} key={widget} tabIndex={0} role="group" aria-label={`${WIDGET_LABEL[widget]} disematkan`}>
              <PinBadge />
              {/* The date needs no label and the label would crowd a two-pin card. */}
              {widget !== "calendar" && (
                <span className="notch-pin-label" title={widget === "weather" ? nook.weather.location?.name : undefined}>{WIDGET_LABEL[widget]}</span>
              )}
              <PinnedBody widget={widget} nook={nook} />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

type MenuState = { widget: WidgetId; x: number; y: number };

function pinMenuLabel(verdict: PinVerdict): string {
  if (verdict === "not-pinnable") return "Tidak bisa di-pin";
  if (verdict === "full" || verdict === "last-in-stack") return "Pin penuh (maks. 2)";
  return verdict === "unpin" ? "Unpin widget" : "Pin widget";
}

export function Nook({ nook }: { nook: NookModel }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<MenuState | null>(null);

  const openMenu = useCallback((widget: WidgetId, target: HTMLElement) => {
    const base = root.current?.getBoundingClientRect();
    if (!base) return;
    const rect = target.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left - base.left, 4), Math.max(4, base.width - MENU_WIDTH - 4));
    const below = rect.bottom - base.top + 6;
    const y = below + MENU_HEIGHT <= base.height
      ? below
      : Math.max(4, rect.top - base.top - MENU_HEIGHT - 6);
    setAnchor({ widget, x, y });
  }, []);

  const closeMenu = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    if (!anchor) return;
    const onPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [anchor, closeMenu]);

  const verdict = anchor ? nook.verdict(anchor.widget) : "pin";

  return (
    <div
      ref={root}
      className="notch-nook"
      onWheelCapture={anchor ? closeMenu : undefined}
    >
      {runtimeConfig.features.media && <MediaPanel nook={nook} />}
      {nook.stack.length > 0 && <WidgetStack nook={nook} onMenu={openMenu} />}
      {!runtimeConfig.features.media && nook.stack.length === 0 && <p className="nook-disabled">Pilih fitur dan widget melalui klik kanan → Konfigurasi NotchApp.</p>}
      {nook.pinned.length > 0 && <PinnedColumn nook={nook} onMenu={openMenu} />}

      <AnimatePresence>
        {anchor && (
          <motion.div
            ref={menu}
            className="notch-menu"
            role="menu"
            aria-label={`Menu ${WIDGET_LABEL[anchor.widget]}`}
            style={{ left: anchor.x, top: anchor.y }}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="notch-menu-item"
              disabled={verdict === "full" || verdict === "last-in-stack" || verdict === "not-pinnable"}
              onClick={() => {
                if (verdict === "pin") nook.pin(anchor.widget);
                else if (verdict === "unpin") nook.unpin(anchor.widget);
                closeMenu();
              }}
            >
              {pinMenuLabel(verdict)}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
