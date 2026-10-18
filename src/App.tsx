import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Foundation prototype: a notch that opens, closes and settles cleanly.
 *
 * Three sizes, all sharing one spring per direction. Every future tab will reuse
 * EXPANDED so the geometry never changes between tabs, and both the size and the
 * bottom corner radius run off the same animation.
 */
const COLLAPSED = { width: 200, height: 34, radius: 14, ear: 6 };
/**
 * Plugging in is the one activity that gets a shape of its own: wider and taller
 * than the clock's bar, and rounder to match. The main panel is not involved.
 */
const CHARGING = { width: 300, height: 52, radius: 24, ear: 14 };
const EXPANDED = { width: 420, height: 160, radius: 28, ear: 14 };

/**
 * Spring Expand / Spring Collapse from the spec.
 *
 * Spring Expand (stiffness 380, damping 26, mass 0.9) is underdamped - damping
 * ratio ~0.70 - so it overshoots by about 4.5% of the distance travelled:
 * opening measures 420 wide at rest but peaks near 430, and 160 tall peaking
 * near 166. That overshoot is why the window keeps transparent margins.
 *
 * Spring Collapse (stiffness 500, damping 40) has a ratio of ~0.89, i.e. the
 * damping table's "almost no bounce". Measured, the close settles flat with no
 * visible springback. That is what the spec asked for; if a livelier close is
 * ever wanted, damping 26-30 on this spring is the knob.
 */
const SPRING_OPEN: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 26,
  mass: 0.9,
};
const SPRING_CLOSE: Transition = { type: "spring", stiffness: 500, damping: 40 };

/**
 * Content Blur Fade-In / Content Blur Fade-Out. The fade-in starts 80ms after
 * the press so the panel has already opened up behind it; the fade-out is
 * deliberately quick, because the panel is shrinking under it at the same time.
 */
const CONTENT_ENTER: Transition = { duration: 0.25, delay: 0.08, ease: "easeOut" };
const CONTENT_EXIT: Transition = { duration: 0.12 };

/**
 * The idle clock: `HH:mm`, 24-hour local time, exactly as the WPF original
 * formatted it. Built by hand rather than through Intl so the two-digit shape
 * survives a machine whose locale formats hours its own way.
 */
const formatClock = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/**
 * Activity indicators: the charger, a network, a Bluetooth device, a USB
 * device. Native detects them (see `activity.rs`) and each one takes the
 * clock's place for three seconds, in turn, before the clock comes back.
 */
type ActivityKind =
  | "power-connected"
  | "power-disconnected"
  | "wifi-connected"
  | "ethernet-connected"
  | "bluetooth-connected"
  | "usb-connected"
  | "usb-disconnected";

type ActivityEvent = { kind: ActivityKind; detail: string };
type Activity = ActivityEvent & { id: number };

/** The charger's state; mirrors `PowerState` in src-tauri. */
type PowerState = { plugged: boolean; percentage: string };

const ACTIVITY_MS = 3000;
/**
 * The charger gets longer than the rest: it has an animation to play - the bolt
 * drawing itself, the number counting up, the bar filling - and something to
 * read once it has. The clock starts when that animation does.
 */
const POWER_MS = 3500;
/**
 * A beat between the charger's bar shrinking and the next indicator appearing:
 * the bar goes back to the clock's size first, with nothing on it, rather than
 * the next activity showing up inside a bar that is still collapsing.
 */
const CHARGING_SETTLE_MS = 460;
/** Guard against a device flapping faster than the queue can drain. */
const ACTIVITY_QUEUE_MAX = 8;

/** Charger arrival timings, in seconds, straight from the spec. */
const COUNT_UP_MS = 900;
const BOLT_DRAW: Transition = { duration: 0.5, delay: 0.12, ease: "easeOut" };
const BOLT_FILL: Transition = { duration: 0.25, delay: 0.5, ease: "easeOut" };
const LEVEL_FILL: Transition = { duration: 0.7, delay: 0.15, ease: "easeOut" };
const PULSE_RING: Transition = { duration: 1.4, ease: "easeOut", repeat: Infinity };

/**
 * The bolt is drawn rather than typed: it has to be a real path so the stroke can
 * draw itself in (`pathLength`) and the fill can arrive afterwards, which the
 * emoji could not do.
 */
const BOLT_PATH = "M12.6 2.4 5.2 13.4h5.9l-.5 8.2 8.6-11.3h-6.3z";

/**
 * How each event presents itself. The wording is the part that does not come
 * from the machine; `detail` is the SSID, the device name, the percentage.
 *
 * The two power events are the ones without a glyph, and they no longer look
 * alike: plugging in gets the drawn bolt and the progress bar (see
 * `ChargingContent`), while unplugging stays on the small bar with the battery
 * the WPF original drew by hand.
 */
const ACTIVITY: Record<
  ActivityKind,
  { text: (detail: string) => string; glyph?: string }
> = {
  "power-connected": {
    text: (detail) => (detail ? `Mengisi daya · ${detail}` : "Mengisi daya"),
  },
  "power-disconnected": {
    text: (detail) =>
      detail ? `Charger dicabut · ${detail}` : "Charger dicabut",
  },
  "wifi-connected": {
    glyph: "\uE701",
    text: (detail) => (detail ? `Wi-Fi · ${detail}` : "Wi-Fi terhubung"),
  },
  "ethernet-connected": {
    glyph: "\uE839",
    text: () => "Ethernet terhubung",
  },
  "bluetooth-connected": {
    glyph: "\uE702",
    text: (detail) =>
      detail ? `Bluetooth · ${detail}` : "Bluetooth terhubung",
  },
  "usb-connected": {
    glyph: "\uE88E",
    text: (detail) => (detail ? `USB · ${detail}` : "USB terhubung"),
  },
  "usb-disconnected": {
    glyph: "\uE88E",
    text: (detail) => (detail ? `${detail} dilepas` : "USB dilepas"),
  },
};

/**
 * The WPF charge row, in DOM: a 30x14 outline with a 2.5px inset grey fill whose
 * width tracks the level (25px at 100%, exactly what `ChargeFill.Width` did) and
 * the little nub on the right.
 */
function Battery({ detail }: { detail: string }) {
  const percent = Number.parseInt(detail, 10);
  const level = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;

  return (
    <span className="notch-battery" aria-hidden="true">
      <span className="notch-battery-fill" style={{ width: `${level * 0.25}px` }} />
      <span className="notch-battery-nub" />
    </span>
  );
}

/**
 * The level counts *up* to what the battery actually is, so plugging in reads as
 * charging rather than as a number that was already there. The value the machine
 * reported is where it lands, not where it starts.
 */
function useCountUp(value: number, instant: boolean) {
  const [shown, setShown] = useState(instant ? value : 0);

  useEffect(() => {
    if (instant) {
      // Reduced motion: the level is simply there at its final value.
      setShown(value);
      return;
    }

    const started = performance.now();
    let frame = window.requestAnimationFrame(function step() {
      const progress = Math.min(1, (performance.now() - started) / COUNT_UP_MS);
      // Ease out: most of the trip happens early, then it settles on the level.
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = window.requestAnimationFrame(step);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [value, instant]);

  return shown;
}

/**
 * Plugging in. The bolt draws itself in and then fills, a ring pulses out from
 * behind it, the level counts up, and the level's own 3px bar grows along the
 * bottom edge with a highlight travelling through it.
 *
 * It sits on its own layer rather than in the clock's 20px row, because it takes
 * the whole bar. Mounted per activity, so a second plug replays all of it.
 */
function ChargingContent({
  detail,
  instant,
}: {
  detail: string;
  instant: boolean;
}) {
  const percent = Number.parseInt(detail, 10);
  const level = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;
  const shown = useCountUp(level, instant);

  return (
    <>
      <div className="notch-charging-row">
        <span className="notch-charging-bolt" aria-hidden="true">
          {!instant && (
            <motion.span
              className="notch-charging-ring"
              initial={{ scale: 1, opacity: 0.5 }}
              animate={{ scale: 1.9, opacity: 0 }}
              transition={PULSE_RING}
            />
          )}
          <svg
            viewBox="0 0 24 24"
            className="notch-charging-bolt-svg"
            aria-hidden="true"
          >
            <motion.path
              d={BOLT_PATH}
              fill="#34d399"
              stroke="#34d399"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              // Reduced motion has nothing to draw: it starts finished.
              initial={instant ? false : { pathLength: 0, fillOpacity: 0 }}
              animate={{ pathLength: 1, fillOpacity: 1 }}
              transition={{ pathLength: BOLT_DRAW, fillOpacity: BOLT_FILL }}
            />
          </svg>
        </span>
        <span className="notch-charging-text">
          Mengisi daya
          <span className="notch-charging-level"> · {shown}%</span>
        </span>
      </div>
      <div className="notch-charging-track">
        <motion.div
          className="notch-charging-fill"
          initial={instant ? false : { width: 0 }}
          animate={{ width: `${level}%` }}
          transition={LEVEL_FILL}
        >
          {!instant && <span className="notch-charging-shimmer" />}
        </motion.div>
      </div>
    </>
  );
}

/**
 * The charger's *state*, not an arrival: this dot is on the bar for as long as
 * the cable is in - including when the app starts with the charger already
 * attached, where nothing is announced - and it blinks slowly while it is there.
 */
function ChargingDot({ instant }: { instant: boolean }) {
  return (
    <motion.span
      aria-hidden="true"
      className="notch-charging-dot"
      initial={instant ? false : { scale: 0 }}
      animate={{ scale: 1, opacity: instant ? 1 : [1, 0.35, 1] }}
      transition={{
        scale: instant
          ? { duration: 0 }
          : { type: "spring", stiffness: 500, damping: 28 },
        opacity: instant
          ? { duration: 0 }
          : { duration: 1.8, repeat: Infinity, ease: "easeInOut", delay: 0.4 },
      }}
    />
  );
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(() => formatClock(new Date()));
  // True while a foreground window covers the collapsed notch (native monitors
  // it, see the autohide module in lib.rs). Autohide never applies to the open
  // panel, so hidden and open are mutually exclusive in practice.
  const [autohide, setAutohide] = useState(false);
  // Activities are queued and shown one at a time, oldest first.
  const [activities, setActivities] = useState<Activity[]>([]);
  const nextActivityId = useRef(0);
  // The charger's state, deliberately *outside* the queue: the dot on the bar is
  // not an event that comes and goes, and a queued indicator must not delay it.
  const [plugged, setPlugged] = useState(false);
  // Set between the charger's bar shrinking and the next indicator taking over.
  const [settling, setSettling] = useState(false);
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while a native call is in flight, which is what lets a fast reverse
  // cancel an open that has not started animating yet.
  const wanted = useRef(false);
  const reducedMotion = useReducedMotion() === true;

  const activity = activities[0];
  // While the panel is open the indicator waits rather than interrupting: it
  // lives on the collapsed bar, so showing it would mean closing what the user
  // just opened. The queue is held, not dropped.
  const showingActivity = activity !== undefined && !open;
  // The arrival is the one activity with a silhouette of its own; the "unplugged"
  // notice stays on the small bar with everything else.
  const charging = showingActivity && activity.kind === "power-connected";
  // What the clock's row shows. The arrival is not part of it - it has its own
  // layer - and while the bar is settling after one, nothing is.
  const rowActivity =
    showingActivity && !settling && !charging ? activity : undefined;
  // An indicator is worth showing even when autohide would have hidden the
  // notch; once it has had its turn the autohide state takes over again.
  // Reporting it as *visible* to native matters: the hook then treats it as a
  // notch again, so it can still be clicked open.
  const hidden = autohide && !showingActivity;

  /**
   * The native window keeps one size for its whole life - a resize makes
   * WebView2 re-create its surface and the notch blinks - so it is larger than
   * the bar and leaves room for the spring's overshoot. Collapsed means
   * "click-through": the window ignores the mouse and a low-level hook notices
   * (and swallows) clicks on the notch itself, while expanded keeps the whole
   * window interactive.
   *
   * The silhouette is handed to the native side in every state, because that is
   * what the hook uses to tell "inside the notch" from "clicked away". A hidden
   * bar has no indicator on it, so hiding only ever applies to the small one.
   */
  const silhouette = open
    ? EXPANDED
    : charging
      ? CHARGING
      : { ...COLLAPSED, height: hidden ? 0 : COLLAPSED.height };

  // Growing uses the expand spring and shrinking the collapse one, which is what
  // the charger asks for - 380/26/0.9 on the way in, 500/40 on the way out. With
  // reduced motion the bar still ends up in the right shape, but it does not
  // spring to get there; the panel's own open and close are left alone.
  const sizeTransition: Transition =
    reducedMotion && !open
      ? { duration: 0 }
      : open || charging
        ? SPRING_OPEN
        : SPRING_CLOSE;
  // Content Blur Fade-In / Fade-Out for the arrival: 8px of blur and a 0.95 scale
  // behind a 250ms fade that starts 80ms after the bar begins to grow. Reduced
  // motion keeps only the fade, and neither the blur nor the scale.
  const chargerEnter: Transition = reducedMotion
    ? { duration: 0.12 }
    : { duration: 0.25, delay: 0.08, ease: "easeOut" };
  const chargerExit: Transition = { duration: 0.12 };

  const setHitArea = useCallback(
    async (state: "collapsed" | "charging" | "expanded") => {
      const size =
        state === "expanded"
          ? EXPANDED
          : state === "charging"
            ? CHARGING
            : COLLAPSED;
      try {
        await invoke("set_notch_hit", {
          width: size.width,
          height: size.height,
          // The arrival is still a bar to click open, not a panel: only the
          // expanded panel wants the window itself interactive.
          clickThrough: state !== "expanded",
        });
      } catch (err) {
        console.error("set_notch_hit failed:", err);
      }
    },
    [],
  );

  const openPanel = useCallback(async () => {
    wanted.current = true;
    // Stop passing clicks through before the notch starts growing, otherwise
    // the panel would be click-through while it animates in.
    await setHitArea("expanded");
    if (!wanted.current) return; // reversed while the call was in flight
    setOpen(true);
  }, [setHitArea]);

  const closePanel = useCallback(() => {
    wanted.current = false;
    setOpen(false);
  }, []);

  /**
   * A press on the notch may only ever *open* it. Once the panel is open the
   * whole area is the panel, so a click there belongs to the panel (and to
   * whatever control ends up inside it); closing is the job of the outside
   * click, not of a click on the panel itself.
   */
  const pressNotch = useCallback(() => {
    if (wanted.current) return;
    void openPanel();
  }, [openPanel]);

  /**
   * The notch menu is native (Windows draws it and it can extend past the
   * window), so it is a Rust command either way - reached from the DOM when the
   * panel is interactive, and from the low-level hook when the collapsed window
   * is click-through and the DOM sees nothing at all.
   */
  const showMenu = useCallback(async () => {
    try {
      await invoke("show_notch_menu");
    } catch (err) {
      console.error("show_notch_menu failed:", err);
    }
  }, []);

  const handleSettled = useCallback(() => {
    // Only once the closing spring has come to rest is the notch small enough
    // to hand the mouse back to the desktop; doing it earlier would make the
    // shrinking panel click-through mid-flight. Which silhouette just settled
    // depends on what is on the bar: the charger's is wider than the clock's.
    if (!wanted.current) void setHitArea(charging ? "charging" : "collapsed");
  }, [setHitArea, charging]);

  // Re-assert the collapsed state as soon as the webview is alive.
  useEffect(() => {
    void setHitArea("collapsed");
  }, [setHitArea]);

  // Native has to guard the charger's own rect *before* the bar starts growing,
  // or the hook would still be watching the smaller one while the bar is already
  // wider than it and clicks near its corners would fall through.
  useEffect(() => {
    if (charging) void setHitArea("charging");
  }, [charging, setHitArea]);

  /**
   * Idle clock. Every tick re-reads the system time instead of counting up, so
   * a machine that slept with the notch on screen shows the right time on the
   * first tick after waking. The timeout is aligned to the next wall-clock
   * second, which keeps it from drifting the way a bare 1000ms would.
   */
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          setTime(formatClock(new Date()));
          schedule();
        },
        1000 - (Date.now() % 1000) + 20,
      );
    };
    schedule();
    // Belt and braces for the resume case: the webview may not run timers
    // while the window is occluded.
    const resync = () => setTime(formatClock(new Date()));
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, []);

  // Autohide: native polls the foreground window and tells us when the notch is
  // covered, and when the cursor is bumped back against the top edge.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<boolean>("notch-autohide", (event) =>
      setAutohide(event.payload),
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // Charger, network, Bluetooth and USB, detected natively.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<ActivityEvent>("notch-activity", (event) =>
      setActivities((queue) => {
        if (queue.length >= ACTIVITY_QUEUE_MAX) return queue;
        return [...queue, { ...event.payload, id: nextActivityId.current++ }];
      }),
    ).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // The charger's *state*, which is what keeps the dot on the bar. Asking for it
  // on mount matters: native's first poll can beat this listener, and a machine
  // that was already charging would then have no dot until the cable moved.
  const sawPowerEvent = useRef(false);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<PowerState>("notch-power", (event) => {
      sawPowerEvent.current = true;
      setPlugged(event.payload.plugged);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    void invoke<PowerState | null>("power_state")
      .then((state) => {
        // Anything that arrived while the call was in flight is newer news.
        if (state && !sawPowerEvent.current) setPlugged(state.plugged);
      })
      .catch((err) => console.error("power_state failed:", err));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  /**
   * One activity at a time, then the next. The timer only runs while the
   * activity is actually on screen: opening the panel pauses it, so an indicator
   * cannot burn its time behind an open panel, and closing the panel gives the
   * one still showing a fresh turn.
   *
   * Two things are specific to the charger: it gets longer on the bar, counted
   * from the moment its animation starts, and once it is over the bar is left to
   * shrink back to the clock's size on its own before the next indicator takes
   * its place - so nothing appears inside a bar that is still collapsing.
   */
  useEffect(() => {
    if (activity === undefined || open || settling) return;
    const dwell = charging ? POWER_MS : ACTIVITY_MS;
    const timer = window.setTimeout(() => {
      setActivities((queue) => queue.slice(1));
      if (!charging) return;
      setSettling(true);
      window.setTimeout(() => setSettling(false), CHARGING_SETTLE_MS);
    }, dwell);
    return () => window.clearTimeout(timer);
  }, [activity, open, settling, charging]);

  // Hiding never changes the click-through state - autohide only ever applies
  // while the notch is collapsed, and collapsed is already click-through. What
  // native does need to know is that there is no notch to click any more, or
  // the hook would go on swallowing presses aimed at the window on top.
  useEffect(() => {
    void invoke("set_notch_hidden", { hidden }).catch(() => {});
  }, [hidden]);

  // Outside clicks come from the native low-level mouse hook.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen("notch-click-outside", () => closePanel()).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [closePanel]);

  // While collapsed the window is click-through, so a click on the notch never
  // reaches the DOM: the hook recognises it and tells us instead.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen("notch-press", () => void openPanel()).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [openPanel]);

  // Same story for a right-click on the collapsed notch.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen("notch-context", () => void showMenu()).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [showMenu]);

  // Keep the native click-outside hook aware of whether the panel is open.
  useEffect(() => {
    void invoke("set_panel_open", { open }).catch(() => {});
  }, [open]);

  return (
    <div className="h-full w-full select-none bg-transparent">
      {/* The charger's glow is cast from a layer of its own: the shell clips
          itself - which is what keeps the ears tidy and slides the bar out of
          sight on autohide - and a clip-path would cut the shadow off with it. */}
      <motion.div
        aria-hidden="true"
        initial={false}
        animate={{
          width: silhouette.width,
          height: silhouette.height,
          borderBottomLeftRadius: silhouette.radius,
          borderBottomRightRadius: silhouette.radius,
          opacity: charging ? 1 : 0,
        }}
        transition={{
          ...sizeTransition,
          opacity: { duration: reducedMotion ? 0 : 0.2 },
        }}
        className="notch-glow pointer-events-none absolute top-0 left-1/2 -translate-x-1/2"
      />
      <motion.div
        data-notch="1"
        data-activity={
          !settling && showingActivity && activity !== undefined
            ? activity.kind
            : ""
        }
        role="button"
        tabIndex={0}
        aria-label="Notch"
        aria-expanded={open}
        aria-hidden={hidden}
        initial={false}
        animate={{
          width: silhouette.width,
          // Autohide slides the bar up out of sight - its height is already 0 in
          // that state - while the width stays put, as in the WPF original.
          height: silhouette.height,
          borderBottomLeftRadius: silhouette.radius,
          borderBottomRightRadius: silhouette.radius,
          "--ear-size": `${silhouette.ear}px`,
        }}
        transition={sizeTransition}
        onAnimationComplete={handleSettled}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          pressNotch();
        }}
        onContextMenu={(event) => {
          // Suppress the webview's own menu and show the notch menu instead.
          event.preventDefault();
          void showMenu();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          pressNotch();
        }}
        className="notch-shell absolute top-0 left-1/2 -translate-x-1/2 outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      >
        <div className="notch-body">
          {/* The clock and the content are separate layers: neither can push the
              other around while one fades in and the other out, and the clock
              sits at the same 8px/20px row the WPF original used. It fades into
              the panel as it opens rather than overlapping it. */}
          <motion.div
            aria-hidden={open}
            initial={false}
            animate={{
              opacity: open ? 0 : 1,
              filter: open ? "blur(6px)" : "blur(0px)",
              scale: open ? 0.95 : 1,
            }}
            transition={open ? CONTENT_EXIT : CONTENT_ENTER}
            className="notch-clock pointer-events-none absolute inset-x-0 top-2 flex h-5 items-center justify-center px-3 text-sm text-white"
          >
            {/* One indicator at a time takes the clock's place; the WPF original
                kept the clock and put the activity beside it, but the clock is
                what this notch shows when it has nothing to say. */}
            <AnimatePresence mode="wait" initial={false}>
              {rowActivity ? (
                <motion.div
                  key={rowActivity.id}
                  initial={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                  exit={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="notch-activity flex min-w-0 items-center gap-1"
                >
                  {(() => {
                    const look = ACTIVITY[rowActivity.kind];
                    const power = rowActivity.kind.startsWith("power-");
                    return (
                      <>
                        {power ? (
                          <Battery detail={rowActivity.detail} />
                        ) : (
                          <span className="notch-activity-glyph">
                            {look.glyph}
                          </span>
                        )}
                        <span
                          className="notch-activity-text truncate"
                          data-power={power || undefined}
                        >
                          {look.text(rowActivity.detail)}
                        </span>
                      </>
                    );
                  })()}
                </motion.div>
              ) : charging || settling ? null : (
                <motion.div
                  key="clock"
                  initial={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                  exit={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="flex items-center"
                >
                  {time}
                  {/* Only ever on the bar itself: an activity takes the clock's
                      place, and the dot goes with it. */}
                  {plugged && <ChargingDot instant={reducedMotion} />}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          {/* Plugging in takes the whole bar rather than the clock's 20px row, so
              it is a layer of its own - and keyed per activity, so a second plug
              replays the arrival from the start. */}
          <AnimatePresence>
            {charging && (
              <motion.div
                key={activity.id}
                initial={
                  reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, filter: "blur(8px)", scale: 0.95 }
                }
                animate={
                  reducedMotion
                    ? { opacity: 1 }
                    : { opacity: 1, filter: "blur(0px)", scale: 1 }
                }
                exit={
                  reducedMotion
                    ? { opacity: 0, transition: chargerExit }
                    : { opacity: 0, filter: "blur(6px)", transition: chargerExit }
                }
                transition={chargerEnter}
                className="notch-charging"
              >
                <ChargingContent detail={activity.detail} instant={reducedMotion} />
              </motion.div>
            )}
          </AnimatePresence>
          {/* Placeholder only: the tabs replace this next. */}
          <AnimatePresence>
            {open && (
              <motion.div
                key="content"
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: CONTENT_EXIT }}
                transition={CONTENT_ENTER}
                className="flex h-full w-full items-center justify-center"
              >
                <span className="text-xs font-medium tracking-wide text-white/45">
                  Panel content
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
