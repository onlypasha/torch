import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import type { PanInfo, Transition } from "framer-motion";
import { useCoverAccent } from "./accent";
import { mediaCaption, mediaPercent, mediaTime, seekRatio, seekTarget, REPEAT_LABEL } from "./media";
import { LYRIC_FAILED, LYRIC_LOADING, LYRIC_UNAVAILABLE } from "./lyrics";
import {
  calendarTitle,
  compactMonth,
  POMODORO_SESSION,
  POMODORO_STATUS,
  pomodoroClock,
  pomodoroFraction,
  STACK_POSITION,
  stackOffset,
  stackSlot,
  weekOf,
  weekdayLong,
  WIDGET_LABEL,
  WEATHER,
} from "./nook";
import type { WidgetId } from "./nook";
import type { NookModel } from "./useNook";

/**
 * The Nook tab: fixed media panel, the rotating widget stack and (when any
 * widget is pinned) the compact column that widens the whole notch.
 *
 * The three parts never resize with the shell: the panel grows 520 -> 642 by
 * adding the pinned column beside them, so the stack keeps its full 276px.
 */

const STACK_SPRING: Transition = { type: "spring", stiffness: 420, damping: 34 };
const REORDER_SPRING: Transition = { type: "spring", stiffness: 500, damping: 36 };
const LYRIC_SPRING: Transition = { type: "spring", stiffness: 400, damping: 32 };
const RING_SPRING: Transition = { duration: 0.4, ease: "easeOut" };
const PIN_IN: Transition = { type: "spring", stiffness: 420, damping: 32, delay: 0.1 };
const PIN_OUT: Transition = { duration: 0.15 };

const MENU_WIDTH = 180;
const MENU_HEIGHT = 50;
const WHEEL_COOLDOWN = 320;
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
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);

  const duration = media?.durationMs ?? 0;
  const canSeek = media?.canSeek === true && duration > 0;
  const percent = mediaPercent(positionMs, duration);

  const ratioAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return seekRatio(clientX, rect.left, rect.width);
  };

  const finish = (clientX: number) => {
    if (!dragging.current) return;
    dragging.current = false;
    nook.commitSeek(ratioAt(clientX));
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
          if (!canSeek || event.button !== 0) return;
          dragging.current = true;
          // A capture on a pointer the browser no longer tracks throws; the
          // drag still works without it, so this must never break the handler.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* not capturable in this environment */
          }
          nook.beginSeek();
          nook.previewSeek(ratioAt(event.clientX));
        }}
        onPointerMove={(event) => {
          const ratio = ratioAt(event.clientX);
          if (dragging.current) nook.previewSeek(ratio);
          else if (canSeek) setHover(ratio);
        }}
        onPointerUp={(event) => finish(event.clientX)}
        onPointerCancel={(event) => finish(event.clientX)}
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

type Volume = { level: number; muted: boolean };

/** System volume, which is what the Windows flyout changes too. */
function VolumePanel({
  anchor,
  onClose,
}: {
  /** The speaker that opened the panel; pressing it again must close, not reopen. */
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [volume, setVolume] = useState<Volume | null>(null);
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    void invoke<Volume>("volume_get")
      .then((value) => {
        if (!disposed) setVolume(value);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // The speaker's own click toggles the panel; treating it as "outside"
      // would close and immediately reopen it.
      if (card.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const publish = useCallback((next: Volume) => {
    setVolume(next);
    void invoke("volume_set", { level: next.level, muted: next.muted }).catch(() => {
      setFailed(true);
    });
  }, []);

  const level = volume?.level ?? 0;
  const muted = volume?.muted ?? false;

  return (
    <motion.div
      ref={card}
      className="notch-volume"
      role="group"
      aria-label="Volume sistem"
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.96 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      {failed ? (
        <p className="notch-volume-note">Volume sistem tidak tersedia</p>
      ) : (
        <>
          <div className="notch-volume-head">
            <span>{muted ? "Senyap" : "Volume"}</span>
            <span className="notch-volume-value">{volume ? `${Math.round(level * 100)}%` : "…"}</span>
          </div>
          <input
            className="notch-volume-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(level * 100)}
            disabled={!volume}
            aria-label="Tingkat volume"
            onChange={(event) => publish({ level: Number(event.target.value) / 100, muted: false })}
          />
          <button
            type="button"
            className="notch-pill-ghost notch-volume-mute"
            disabled={!volume}
            onClick={() => publish({ level, muted: !muted })}
          >
            {muted ? "Bunyikan" : "Senyapkan"}
          </button>
        </>
      )}
    </motion.div>
  );
}

function MediaPanel({ nook }: { nook: NookModel }) {
  const { media } = nook;
  const caption = mediaCaption(media);
  const playing = media?.playing === true;
  const accent = useCoverAccent(media?.thumbnail);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeButton = useRef<HTMLButtonElement>(null);

  const style = accent ? ({ "--media-accent": accent } as CSSProperties) : undefined;

  return (
    <section className="notch-media" aria-label="Media" style={style}>
      <button
        ref={volumeButton}
        type="button"
        className="notch-media-volume"
        aria-label={volumeOpen ? "Tutup volume" : "Volume sistem"}
        aria-expanded={volumeOpen}
        onClick={() => setVolumeOpen((open) => !open)}
      >
        <TransportIcon path="M3 6.3h2L8.2 3.6v8.8L5 9.7H3ZM10.6 6.1a2.7 2.7 0 0 1 0 3.8M12.4 4.4a5 5 0 0 1 0 7.2" size={13} />
      </button>

      <AnimatePresence>
        {volumeOpen && <VolumePanel anchor={volumeButton} onClose={() => setVolumeOpen(false)} />}
      </AnimatePresence>

      <div className="notch-media-head">
        <div
          className="notch-media-cover"
          data-art={media?.thumbnail ? "true" : "false"}
          style={media?.thumbnail ? { backgroundImage: `url(${media.thumbnail})` } : undefined}
          aria-hidden="true"
        >
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
        </div>
        <div className="notch-media-text">
          <Marquee text={caption.title} className="notch-media-title" />
          <Marquee text={caption.artist} className="notch-media-artist" />
          {caption.album && <Marquee text={caption.album} className="notch-media-album" />}
        </div>
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
          <TransportIcon path={playing ? PAUSE : PLAY} filled={!playing} />
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// Widget bodies
// ---------------------------------------------------------------------------

function CalendarWidget({ compact }: { compact?: boolean }) {
  const today = new Date();
  if (compact) {
    return (
      <div className="notch-calendar-compact">
        <span className="notch-calendar-big">{today.getDate()}</span>
        <span className="notch-calendar-short">{compactMonth(today)}</span>
        <span className="notch-calendar-weekday">{weekdayLong(today)}</span>
      </div>
    );
  }
  return (
    <div className="notch-calendar">
      <span className="notch-calendar-title">{calendarTitle(today)}</span>
      <div className="notch-calendar-week">
        {weekOf(today).map((day) => (
          <span
            key={day.key}
            className="notch-calendar-cell"
            data-today={day.today ? "true" : "false"}
            aria-current={day.today ? "date" : undefined}
          >
            <span className="notch-calendar-day">{day.weekday}</span>
            <span className="notch-calendar-date">{day.day}</span>
          </span>
        ))}
      </div>
      <div className="notch-calendar-event">
        <span className="notch-calendar-dot" aria-hidden="true" />
        <span className="notch-calendar-event-text">Tidak ada acara hari ini</span>
      </div>
    </div>
  );
}

function PomodoroStack({ nook }: { nook: NookModel }) {
  const fraction = pomodoroFraction(nook.pomodoro.remaining);
  const phase = nook.pomodoroPhase;
  return (
    <div className="notch-pomodoro">
      <div className="notch-pomodoro-ring">
        <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true" className="notch-ring">
          <circle cx="42" cy="42" r="39.5" className="notch-ring-track" fill="none" strokeWidth={5} />
          <motion.circle
            cx="42"
            cy="42"
            r="39.5"
            className="notch-ring-fill"
            fill="none"
            strokeWidth={5}
            strokeLinecap="round"
            transform="rotate(-90 42 42)"
            initial={false}
            animate={{ pathLength: fraction }}
            transition={RING_SPRING}
          />
        </svg>
        <span className="notch-pomodoro-session">{POMODORO_SESSION}</span>
      </div>
      <div className="notch-pomodoro-side">
        <span className="notch-pomodoro-time" data-phase={phase}>{pomodoroClock(nook.pomodoro.remaining)}</span>
        <div className="notch-pomodoro-actions">
          <motion.button
            type="button"
            className="notch-pill-light"
            whileTap={{ scale: 0.94 }}
            onClick={nook.togglePomodoro}
          >
            {phase === "running" ? "Jeda" : "Mulai"}
          </motion.button>
          <motion.button
            type="button"
            className="notch-pill-ghost"
            whileTap={{ scale: 0.94 }}
            onClick={nook.resetPomodoro}
          >
            Reset
          </motion.button>
        </div>
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
  ].filter((row) => row.text.length > 0);

  return (
    <div className="notch-lyrics">
      <AnimatePresence initial={false} mode="popLayout">
        {rows.map((row) => (
          <motion.span
            key={`${row.role}:${row.text}`}
            className="notch-lyric-line"
            data-role={row.role}
            data-current={row.current ? "true" : "false"}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: row.current ? 1 : 0.35, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={LYRIC_SPRING}
          >
            {row.text}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

function WeatherWidget({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="notch-weather-compact">
        <span className="notch-weather-temp-small">{WEATHER.temperature}°</span>
        <span className="notch-weather-condition-small">{WEATHER.condition}</span>
      </div>
    );
  }
  return (
    <div className="notch-weather">
      <div className="notch-weather-now">
        <span className="notch-weather-temp">{WEATHER.temperature}°</span>
        <span className="notch-weather-condition">{WEATHER.condition}</span>
      </div>
      <div className="notch-weather-hours">
        {WEATHER.hourly.map((hour) => (
          <span key={hour.label} className="notch-weather-hour">
            <span className="notch-weather-hour-label">{hour.label}</span>
            <span className="notch-weather-hour-temp">{hour.temperature}°</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function WidgetBody({ widget, nook }: { widget: WidgetId; nook: NookModel }) {
  return (
    <div className="notch-widget" data-widget={widget}>
      <span className="notch-widget-label">{WIDGET_LABEL[widget]}</span>
      {widget === "calendar" && <CalendarWidget />}
      {widget === "pomodoro" && <PomodoroStack nook={nook} />}
      {widget === "lyric" && <LyricRows nook={nook} />}
      {widget === "weather" && <WeatherWidget />}
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
  const lastWheel = useRef(0);
  const stack = useRef<HTMLDivElement>(null);

  const onWheel = (event: React.WheelEvent) => {
    if (Math.abs(event.deltaY) < 4) return;
    const now = performance.now();
    if (now - lastWheel.current < WHEEL_COOLDOWN) return;
    lastWheel.current = now;
    nook.step(event.deltaY > 0 ? 1 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nook.step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
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
      onWheel={onWheel}
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
            style={{ zIndex: active ? 10 : slot === "next" ? 5 : 1 }}
            initial={false}
            animate={STACK_POSITION[slot]}
            transition={STACK_SPRING}
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

function PinnedPopover({ widget, nook }: { widget: WidgetId; nook: NookModel }) {
  const today = new Date();
  if (widget === "calendar") {
    return (
      <div className="notch-pin-calendar">
        <span className="notch-pin-big">{today.getDate()}</span>
        <span className="notch-pin-month">{compactMonth(today)}</span>
        <span className="notch-pin-weekday">{weekdayLong(today)}</span>
      </div>
    );
  }
  if (widget === "lyric") {
    return (
      <span className="notch-pin-lyric" data-status={nook.lyrics.status}>
        {nook.lyrics.status === "ready" ? nook.lyricRow.current || LYRIC_UNAVAILABLE : lyricNotice(nook)}
      </span>
    );
  }
  if (widget === "weather") {
    return (
      <div className="notch-pin-weather">
        <span className="notch-pin-weather-temp">{WEATHER.temperature}°</span>
        <span className="notch-pin-weather-condition">{WEATHER.condition}</span>
      </div>
    );
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
            whileDrag: { scale: 1.04, boxShadow: "0 10px 24px rgba(0,0,0,0.5)", zIndex: 20 },
            transition: REORDER_SPRING,
            initial: { opacity: 0, x: 24, scale: 0.9 },
            animate: { opacity: 1, x: 0, scale: 1, transition: PIN_IN },
            exit: { opacity: 0, x: 24, scale: 0.9, transition: PIN_OUT },
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
                whileTap={{ scale: 0.97 }}
                onClick={togglePinnedPomodoro}
                data-phase={nook.pomodoroPhase}
              >
                <span className="notch-pin-track" aria-hidden="true" />
                <span
                  className="notch-pin-progress"
                  aria-hidden="true"
                  style={{ "--fill": pomodoroFraction(nook.pomodoro.remaining) } as CSSProperties}
                />
                <PinBadge />
                <span className="notch-pin-label">Pomodoro</span>
                <span className="notch-pin-time">{pomodoroClock(nook.pomodoro.remaining)}</span>
                <span className="notch-pin-status">{POMODORO_STATUS[nook.pomodoroPhase]}</span>
              </motion.button>
            );
          }

          return (
            <motion.div {...common} key={widget} tabIndex={-1}>
              <PinBadge />
              {/* The date needs no label and the label would crowd a two-pin card. */}
              {widget !== "calendar" && (
                <span className="notch-pin-label">{WIDGET_LABEL[widget]}</span>
              )}
              <PinnedPopover widget={widget} nook={nook} />
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

function pinMenuLabel(verdict: "pin" | "unpin" | "full" | "last-in-stack"): string {
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
      <MediaPanel nook={nook} />
      <WidgetStack nook={nook} onMenu={openMenu} />
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
              disabled={verdict === "full" || verdict === "last-in-stack"}
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
