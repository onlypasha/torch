import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PanInfo, Transition } from "framer-motion";
import { mediaCaption, mediaPercent, mediaTime } from "./media";
import {
  calendarTitle,
  compactMonth,
  LYRIC_LINES,
  LYRIC_SOURCE_AVAILABLE,
  LYRIC_UNAVAILABLE,
  lyricWindow,
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

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const PREVIOUS = "M10.5 4 5 8l5.5 4M13 4v8";
const NEXT = "M5.5 4 11 8l-5.5 4M3 4v8";
const PLAY = "M6 3.8 12 8l-6 4.2Z";
const PAUSE = "M5.5 4v8M10.5 4v8";

function TransportIcon({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      fill={filled ? "currentColor" : "none"}>
      <path d={path} />
    </svg>
  );
}

function MediaPanel({ nook }: { nook: NookModel }) {
  const { media } = nook;
  const caption = mediaCaption(media);
  const percent = media ? mediaPercent(media.positionMs, media.durationMs) : 0;
  const playing = media?.playing === true;

  return (
    <section className="notch-media" aria-label="Media">
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
          <span className="notch-media-title" title={caption.title}>{caption.title}</span>
          <span className="notch-media-artist" title={caption.artist}>{caption.artist}</span>
        </div>
      </div>

      <div className="notch-media-progress" aria-hidden="true">
        <span className="notch-media-track">
          <motion.span
            className="notch-media-fill"
            initial={false}
            animate={{ width: `${percent}%` }}
            transition={playing ? { duration: 1, ease: "linear" } : { duration: 0.2 }}
          />
        </span>
        <span className="notch-media-times">
          <span>{mediaTime(media?.positionMs ?? 0)}</span>
          <span>{mediaTime(media?.durationMs ?? 0)}</span>
        </span>
      </div>

      <div className="notch-media-controls">
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

function LyricRows({ nook }: { nook: NookModel }) {
  if (!LYRIC_SOURCE_AVAILABLE) {
    return (
      <div className="notch-lyrics">
        <motion.span className="notch-lyric-line" data-current="true" data-placeholder="true">
          {LYRIC_UNAVAILABLE}
        </motion.span>
      </div>
    );
  }
  const window = lyricWindow(nook.lyricIndex);
  const rows = [
    { key: nook.lyricIndex - 1, text: window.previous, current: false },
    { key: nook.lyricIndex, text: window.current, current: true },
    { key: nook.lyricIndex + 1, text: window.next, current: false },
  ];
  return (
    <div className="notch-lyrics">
      <AnimatePresence initial={false} mode="popLayout">
        {rows.map((row) => (
          <motion.span
            key={((row.key % LYRIC_LINES.length) + LYRIC_LINES.length) % LYRIC_LINES.length}
            className="notch-lyric-line"
            data-current={row.current ? "true" : "false"}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: row.current ? 1 : 0.35, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
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

function PinnedPopover({ widget, lyricIndex }: { widget: WidgetId; lyricIndex: number }) {
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
      <span className="notch-pin-lyric">
        {LYRIC_SOURCE_AVAILABLE ? lyricWindow(lyricIndex).current : LYRIC_UNAVAILABLE}
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
              <PinnedPopover widget={widget} lyricIndex={nook.lyricIndex} />
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
