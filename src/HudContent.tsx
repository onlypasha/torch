import { useEffect } from "react";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { hudAnnouncement, hudPercent, volumeWaves } from "./hud";

export type HudView =
  | { kind: "volume"; level: number; muted: boolean; failed: boolean }
  | { kind: "brightness"; level: number; failed: boolean };

type Props = {
  hud: HudView;
  /** Increments on every key press; replays the 1 -> 1.18 -> 1 bump. */
  pulse: number;
  /** Increments when a key presses against 0 or 100; replays the wobble. */
  limit: number;
};

const SPRING_STEP = { type: "spring", stiffness: 500, damping: 40 } as const;
const SPRING_SUN = { type: "spring", stiffness: 260, damping: 28 } as const;

/**
 * The temporary HUD that takes the notch's 300x46 shape for a volume or
 * brightness change. It is content only: the shell's size, corners and ears are
 * animated by App's own shape machine.
 */
export function HudContent({ hud, pulse, limit }: Props) {
  const reduced = useReducedMotion() ?? false;
  const percent = hudPercent(
    hud.kind,
    hud.level,
    hud.kind === "volume" ? hud.muted : false,
  );
  const announcement = hudAnnouncement(
    hud.kind,
    hud.level,
    hud.kind === "volume" ? hud.muted : false,
  );

  const value = useSpring(percent, SPRING_STEP);
  useEffect(() => {
    if (reduced) value.jump(percent);
    else value.set(percent);
  }, [percent, reduced, value]);
  const number = useTransform(value, (latest) => String(Math.round(latest)));

  const bump = useAnimationControls();
  useEffect(() => {
    if (reduced || pulse === 0) return;
    void bump.start({
      scale: [1, 1.18, 1],
      transition: { duration: 0.22, ease: "easeOut" },
    });
  }, [bump, pulse, reduced]);

  const wobble = useAnimationControls();
  useEffect(() => {
    if (reduced || limit === 0) return;
    void wobble.start({
      rotate: [0, 6, -2, 0],
      x: [0, 6, -2, 0],
      transition: { duration: 0.28, ease: "easeInOut" },
    });
  }, [limit, reduced, wobble]);

  const silent =
    hud.kind === "volume" && (hud.muted || hud.level <= 0);
  const iconKey =
    hud.kind === "brightness" ? "brightness" : silent ? "volume-silent" : "volume";

  return (
    <div className="notch-hud">
      <motion.div className="notch-hud-row" animate={bump}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={iconKey}
            className="notch-hud-icon"
            data-muted={silent || undefined}
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            {hud.kind === "brightness" ? (
              <SunIcon level={hud.level} reduced={reduced} />
            ) : (
              <SpeakerIcon
                waves={volumeWaves(hud.level, hud.muted)}
                silent={silent}
              />
            )}
          </motion.div>
        </AnimatePresence>

        <motion.div className="notch-hud-track" animate={wobble}>
          <motion.div
            className="notch-hud-fill"
            data-kind={hud.kind}
            data-failed={hud.failed || undefined}
            animate={{ width: `${percent}%` }}
            transition={reduced ? { duration: 0 } : SPRING_STEP}
          />
        </motion.div>

        <span className="notch-hud-value" data-failed={hud.failed || undefined}>
          <motion.span className="notch-hud-number">{number}</motion.span>
          <span className="notch-hud-unit">%</span>
        </span>
      </motion.div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

/**
 * The speaker's three waves are earned by level, as the spec asks: one past
 * silence, one past a third, one past two thirds. A muted (or zero) endpoint
 * has no waves at all and draws the slash instead.
 */
function SpeakerIcon({ waves, silent }: { waves: number; silent: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {[0, 1, 2].map((index) => {
        const paths = [
          "M14.5 9.5a3.5 3.5 0 0 1 0 5",
          "M17 7a7 7 0 0 1 0 10",
          "M19.5 4.5a10.5 10.5 0 0 1 0 15",
        ];
        return (
          <motion.path
            key={paths[index]}
            d={paths[index]}
            initial={false}
            animate={{ opacity: waves > index ? 1 : 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          />
        );
      })}
      <motion.path
        d="M16 9l6 6M22 9l-6 6"
        initial={false}
        animate={
          silent
            ? { pathLength: 1, opacity: 1 }
            : { pathLength: 0, opacity: 0 }
        }
        transition={{ duration: 0.22, ease: "easeOut" }}
      />
    </svg>
  );
}

/**
 * A sun whose core fills in, whose rays light one by one and whose whole face
 * turns up to 45 degrees across the range. Brightness always comes from the
 * panel, so this is a reading, not an optimistic target.
 */
function SunIcon({ level, reduced }: { level: number; reduced: boolean }) {
  const ratio = Math.min(1, Math.max(0, level / 100));
  const transition = reduced ? { duration: 0 } : SPRING_SUN;
  const rays = Array.from({ length: 8 }, (_, index) => {
    const angle = (index * Math.PI) / 4;
    const lit = ratio > index / 8;
    const inner = 7.6;
    const outer = lit ? 10.4 : 7.6;
    return {
      index,
      lit,
      x1: 12 + Math.cos(angle) * inner,
      y1: 12 + Math.sin(angle) * inner,
      x2: 12 + Math.cos(angle) * outer,
      y2: 12 + Math.sin(angle) * outer,
    };
  });

  return (
    <motion.svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fbbf24"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      initial={false}
      animate={{ rotate: ratio * 45 }}
      transition={transition}
    >
      <motion.circle
        cx="12"
        cy="12"
        initial={false}
        animate={{ r: 3 + ratio * 2.2, fillOpacity: 0.2 + ratio * 0.8 }}
        transition={transition}
        fill="#fbbf24"
      />
      {rays.map((ray) => (
        <motion.line
          key={ray.index}
          initial={false}
          animate={{
            x1: ray.x1,
            y1: ray.y1,
            x2: ray.x2,
            y2: ray.y2,
            opacity: ray.lit ? 1 : 0.18,
          }}
          transition={reduced ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
        />
      ))}
    </motion.svg>
  );
}
