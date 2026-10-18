import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Transition } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Foundation prototype: a notch that opens, closes and settles cleanly.
 *
 * Two states, two sizes. Every future tab will reuse EXPANDED so the geometry
 * never changes between tabs, and both the size and the bottom corner radius
 * run off the same spring.
 */
const COLLAPSED = { width: 200, height: 34, radius: 14, ear: 6 };
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

const ACTIVITY_MS = 3000;
/** Guard against a device flapping faster than the queue can drain. */
const ACTIVITY_QUEUE_MAX = 8;

/**
 * How each event presents itself. The wording is the part that does not come
 * from the machine; `detail` is the SSID, the device name, the percentage.
 *
 * Events without a glyph are the two power ones, which use a drawn battery
 * instead - the same 30x14 outline the WPF original used, green while charging
 * and grey once the cable is out.
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
 * The WPF charge row, in DOM: a 30x14 outline with a 2.5px inset fill whose
 * width tracks the level (25px at 100%, exactly what `ChargeFill.Width` did),
 * the little nub on the right, and a bolt that pops in while charging.
 */
function Battery({ detail, charging }: { detail: string; charging: boolean }) {
  const percent = Number.parseInt(detail, 10);
  const level = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;

  return (
    <span className="notch-battery" aria-hidden="true">
      <span
        className="notch-battery-fill"
        data-charging={charging}
        style={{ width: `${level * 0.25}px` }}
      />
      <span className="notch-battery-nub" />
      {charging && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
          className="notch-battery-bolt"
        >
          ⚡
        </motion.span>
      )}
    </span>
  );
}

export default function App() {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(() => formatClock(new Date()));
  // True while a foreground window covers the collapsed notch (native monitors
  // it, see the autohide module in lib.rs). Autohide never applies to the open
  // panel, so hidden and open are mutually exclusive in practice.
  const [autohide, setAutohide] = useState(false);
  // Activities are queued and shown one at a time, oldest first, for three
  // seconds each.
  const [activities, setActivities] = useState<Activity[]>([]);
  const nextActivityId = useRef(0);
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while a native call is in flight, which is what lets a fast reverse
  // cancel an open that has not started animating yet.
  const wanted = useRef(false);

  const activity = activities[0];
  // While the panel is open the indicator waits rather than interrupting: it
  // lives on the collapsed bar, so showing it would mean closing what the user
  // just opened. The queue is held, not dropped.
  const showingActivity = activity !== undefined && !open;
  // An indicator is worth showing even when autohide would have hidden the
  // notch; once it has had its three seconds the autohide state takes over
  // again. Reporting it as *visible* to native matters: the hook then treats it
  // as a notch again, so it can still be clicked open.
  const hidden = autohide && !showingActivity;

  /**
   * The native window keeps one size for its whole life - a resize makes
   * WebView2 re-create its surface and the notch blinks - so it is larger than
   * the panel and leaves room for the spring's overshoot. Collapsed means
   * "click-through": the window ignores the mouse and a low-level hook notices
   * (and swallows) clicks on the notch itself, while expanded keeps the whole
   * window interactive.
   *
   * The silhouette is handed to the native side in both states, because that
   * is what the hook uses to tell "inside the panel" from "clicked away".
   */
  const setHitArea = useCallback(async (state: "collapsed" | "expanded") => {
    const size = state === "collapsed" ? COLLAPSED : EXPANDED;
    try {
      await invoke("set_notch_hit", {
        width: size.width,
        height: size.height,
        clickThrough: state === "collapsed",
      });
    } catch (err) {
      console.error("set_notch_hit failed:", err);
    }
  }, []);

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
    // shrinking panel click-through mid-flight.
    if (!wanted.current) void setHitArea("collapsed");
  }, [setHitArea]);

  // Re-assert the collapsed state as soon as the webview is alive.
  useEffect(() => {
    void setHitArea("collapsed");
  }, [setHitArea]);

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

  /**
   * Three seconds per activity, then the next one. The timer only runs while
   * the activity is actually on screen: opening the panel pauses it, so an
   * indicator cannot burn its time behind an open panel, and closing the panel
   * gives the one still showing a fresh three seconds.
   */
  useEffect(() => {
    if (activity === undefined || open) return;
    const timer = window.setTimeout(() => {
      setActivities((queue) => queue.slice(1));
    }, ACTIVITY_MS);
    return () => window.clearTimeout(timer);
  }, [activity, open]);

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
      <motion.div
        data-notch="1"
        data-activity={showingActivity ? activity.kind : ""}
        role="button"
        tabIndex={0}
        aria-label="Notch"
        aria-expanded={open}
        aria-hidden={hidden}
        initial={false}
        animate={{
          width: open ? EXPANDED.width : COLLAPSED.width,
          // Hidden slides the bar up out of sight; the width stays put, as in
          // the WPF original, so only the height is animated.
          height: open ? EXPANDED.height : hidden ? 0 : COLLAPSED.height,
          borderBottomLeftRadius: open ? EXPANDED.radius : COLLAPSED.radius,
          borderBottomRightRadius: open ? EXPANDED.radius : COLLAPSED.radius,
          "--ear-size": `${open ? EXPANDED.ear : COLLAPSED.ear}px`,
        }}
        transition={open ? SPRING_OPEN : SPRING_CLOSE}
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
              {showingActivity ? (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                  exit={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="notch-activity flex min-w-0 items-center gap-1"
                >
                  {(() => {
                    const look = ACTIVITY[activity.kind];
                    const power = activity.kind.startsWith("power-");
                    return (
                      <>
                        {power ? (
                          <Battery
                            detail={activity.detail}
                            charging={activity.kind === "power-connected"}
                          />
                        ) : (
                          <span className="notch-activity-glyph">
                            {look.glyph}
                          </span>
                        )}
                        <span
                          className="notch-activity-text truncate"
                          data-power={power || undefined}
                        >
                          {look.text(activity.detail)}
                        </span>
                      </>
                    );
                  })()}
                </motion.div>
              ) : (
                <motion.div
                  key="clock"
                  initial={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                  exit={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  {time}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
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
