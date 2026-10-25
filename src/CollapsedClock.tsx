import { AnimatePresence, motion } from "framer-motion";
import { pomodoroClock } from "./nook";
import { pomodoroIndicator } from "./pomodoro";
import type { PomodoroState } from "./pomodoro";

/** One quiet status slot, independent of the clock's fixed centre. */
export function CollapsedClock({ time, pomodoro, playing, thumbnail, visible }: {
  time: string;
  pomodoro: PomodoroState;
  playing: boolean;
  thumbnail?: string;
  visible: boolean;
}) {
  const timer = pomodoroIndicator(pomodoro);
  const status = visible ? timer ?? (playing ? "media" : null) : null;
  return (
    <div className="notch-clock-row">
      {/* Boring Notch keeps a sliver of the sleeve on the left of the closed
          bar. It is decoration only, so it never takes the clock's width. */}
      {thumbnail && (
        <span
          className="notch-clock-art"
          style={{ backgroundImage: `url(${thumbnail})` }}
          aria-hidden="true"
        />
      )}
      <span className="notch-clock-time">{time}</span>
      <AnimatePresence initial={false} mode="wait">
        {status && (
          <motion.span key={status}
            className={`notch-clock-status ${status === "media" ? "notch-clock-media" : "notch-clock-timer"}`}
            data-phase={status}
            aria-label={status === "media" ? "Sedang memutar media"
              : status === "finished" ? "Pomodoro selesai"
                : `Pomodoro ${status === "paused" ? "dijeda" : "berjalan"}, ${pomodoroClock(pomodoro.remaining)}`}
            initial={{ opacity: 0, x: 2 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -2 }}
            transition={{ duration: 0.16, ease: "easeOut" }}>
            {status === "media" ? (
              <span className="notch-clock-bars" aria-hidden="true">
                {[0, 1, 2].map((bar) => (
                  <span key={bar} className="notch-clock-bar" style={{ animationDelay: `${bar * 0.2}s` }} />
                ))}
              </span>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"
                  fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  {status === "finished" ? <path d="m3 8 3 3 7-7" />
                    : status === "paused" ? <path d="M5 3v10M11 3v10" />
                      : <><circle cx="8" cy="9" r="5" /><path d="M6 1h4M8 6v3l2 1" /></>}
                </svg>
                <span>{status === "finished" ? "Selesai" : pomodoroClock(pomodoro.remaining)}</span>
              </>
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
