import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
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
 * The indicators that take the whole bar - the charger's arrival and a network
 * coming up - share this shape: wider and taller than the clock's bar, and
 * rounder to match. The main panel is not involved.
 */
const TALL = { width: 300, height: 52, radius: 24, ear: 14 };
const EXPANDED = { width: 420, height: 160, radius: 28, ear: 14 };

/**
 * The three shapes the bar can be in. The destination is what picks the spring -
 * growing into the panel or into the tall bar springs open, shrinking back to
 * the clock's bar springs shut - so the shape is named separately from its size.
 */
type Bar = "bar" | "tall" | "panel";
const BAR_SIZES: Record<Bar, typeof COLLAPSED> = {
  bar: COLLAPSED,
  tall: TALL,
  panel: EXPANDED,
};

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
  | "wifi"
  | "ethernet"
  | "bluetooth-connected"
  | "usb-connected"
  | "usb-disconnected";

/**
 * What native actually sends. The networks arrive as a short sequence - an
 * attempt starting, then answering or giving up - which `enqueue` folds into the
 * one activity it is really about.
 */
type WireKind =
  | Exclude<ActivityKind, "wifi" | "ethernet">
  | "wifi-connecting"
  | "wifi-connected"
  | "wifi-lost"
  | "ethernet-detected"
  | "ethernet-connected"
  | "ethernet-lost";

/** The plain row: everything that does not take the whole bar. */
type RowKind =
  | "power-disconnected"
  | "bluetooth-connected"
  | "usb-connected"
  | "usb-disconnected";

type WireEvent = { kind: WireKind; detail: string };

/** Which network an activity is about. */
type NetKind = "wifi" | "ethernet";

/**
 * What a network indicator is showing. `failed` and `lost` are the same notice
 * with different wording: the first for a link that never came up, the second
 * for one that did and then went away.
 */
type NetPhase = "connecting" | "connected" | "failed" | "lost";

type Network = {
  phase: NetPhase;
  /**
   * Native has confirmed the link. The intro phase still holds the indicator
   * until its minimum has had its time on screen, which is what keeps these two
   * apart.
   */
  up: boolean;
};

type Activity = {
  id: number;
  kind: ActivityKind;
  detail: string;
  net?: Network;
};

const ACTIVITY_MS = 3000;
/**
 * The charger gets longer than the rest: it has an animation to play - the bolt
 * drawing itself, the number counting up, the bar filling - and something to
 * read once it has. The clock starts when that animation does.
 */
const POWER_MS = 3500;
/**
 * A beat between a tall indicator's bar shrinking and the next one appearing: the
 * bar goes back to the clock's size first, with nothing on it, rather than the
 * next activity showing up inside a bar that is still collapsing.
 */
const SETTLE_MS = 460;
/** Guard against a device flapping faster than the queue can drain. */
const ACTIVITY_QUEUE_MAX = 8;

/**
 * Network timings, in milliseconds.
 *
 * The intro phase has a minimum rather than a dwell: the indicator stays on the
 * bar until the network actually answers, and the minimum is only there so a
 * connection that is over in a blink still reads as an arrival. Wi-Fi gets the
 * longer one because associating and authenticating take a moment; a cable
 * either has a link or it does not.
 */
const NET_INTRO_MS: Record<NetKind, number> = { wifi: 1500, ethernet: 800 };
/** How long the link itself stays up on the bar before it collapses. */
const NET_LINK_MS = 2600;
/** The failure and disconnect notices. */
const NET_NOTICE_MS = 1600;
/**
 * A backstop for a machine that never answers at all - a wireless service that
 * dies mid-attempt says nothing, and the indicator would otherwise sit there
 * holding the clock's place.
 */
const NET_GIVE_UP_MS = 12000;

/**
 * The wire events, grouped by the activity they belong to. Which of the two
 * phases a `lost` event ends up in is decided when it arrives, from how far the
 * indicator had got (see `enqueue`).
 */
const NETWORK_WIRE: Partial<
  Record<WireKind, { kind: NetKind; event: "connecting" | "connected" | "lost" }>
> = {
  "wifi-connecting": { kind: "wifi", event: "connecting" },
  "wifi-connected": { kind: "wifi", event: "connected" },
  "wifi-lost": { kind: "wifi", event: "lost" },
  "ethernet-detected": { kind: "ethernet", event: "connecting" },
  "ethernet-connected": { kind: "ethernet", event: "connected" },
  "ethernet-lost": { kind: "ethernet", event: "lost" },
};

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
 * How each plain event presents itself. The wording is the part that does not
 * come from the machine; `detail` is the device name or the percentage.
 *
 * The two power events are the ones without a glyph, and they no longer look
 * alike: plugging in gets the drawn bolt and the progress bar (see
 * `ChargingContent`), while unplugging stays on the small bar with the battery
 * the WPF original drew by hand. The networks are not here either: they have a
 * layer of their own, with two phases to show (see `NetworkContent`).
 */
const ROW: Record<RowKind, { text: (detail: string) => string; glyph?: string }> = {
  "power-disconnected": {
    text: (detail) =>
      detail ? `Charger dicabut · ${detail}` : "Charger dicabut",
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

/** Whether the clock's row is what this activity is drawn in. */
const isRow = (kind: ActivityKind): kind is RowKind =>
  kind === "power-disconnected" ||
  kind === "bluetooth-connected" ||
  kind === "usb-connected" ||
  kind === "usb-disconnected";

/**
 * The network an activity is about, if it is one. Narrowing the kind here is what
 * tells the rest of the file which of the two tall indicators it is looking at.
 */
function networkOf(
  activity: Activity,
): (Network & { kind: NetKind; detail: string }) | undefined {
  if (activity.kind !== "wifi" && activity.kind !== "ethernet") return undefined;
  if (activity.net === undefined) return undefined;
  return { ...activity.net, kind: activity.kind, detail: activity.detail };
}

/** One activity in the queue, replaced where it stands. */
function replace(
  queue: Activity[],
  at: number,
  change: { detail: string; net: Network },
): Activity[] {
  return queue.map((item, index) =>
    index === at ? { ...item, ...change } : item,
  );
}

/**
 * The queue. Everything queues one activity per event, except the networks: a
 * connection arrives as two or three events, and they are all one indicator that
 * changes phase rather than several that show up one after another.
 *
 * `open` decides whether a link that is already up counts as old news. If the
 * notch was busy - the panel open, another indicator ahead - then the connection
 * finished while nobody was looking, and showing its latest state beats replaying
 * an arrival that has already happened. A fresh one on an idle bar still gets its
 * opening act.
 */
function enqueue(
  queue: Activity[],
  event: WireEvent,
  open: boolean,
  nextId: number,
): Activity[] {
  const wire = NETWORK_WIRE[event.kind];
  if (wire === undefined) {
    return [
      ...queue,
      { id: nextId, kind: event.kind as ActivityKind, detail: event.detail },
    ];
  }

  const at = queue.map((item) => item.kind).lastIndexOf(wire.kind);
  const before = at === -1 ? undefined : queue[at];
  // The head of the queue is the one on the bar, unless the panel is over it.
  const onScreen = at === 0 && !open;

  if (wire.event === "lost") {
    // A link going away is only worth the bar if that network was just on it.
    if (before === undefined) return queue;
    return replace(queue, at, {
      detail: before.detail,
      net: {
        // A link that had come up says it was cut; one that never got there
        // says it failed.
        phase: before.net?.up ? "lost" : "failed",
        up: false,
      },
    });
  }

  if (wire.event === "connecting") {
    // Already sitting on the attempt: there is nothing to change, and replacing
    // the activity anyway would restart the intro's minimum.
    if (
      before?.net?.phase === "connecting" &&
      !before.net.up &&
      before.detail === event.detail
    ) {
      return queue;
    }

    // A fresh attempt replays the arrival, whether or not this network was
    // already on the bar.
    const attempt = { detail: event.detail, net: { phase: "connecting" as const, up: false } };
    return before === undefined
      ? [...queue, { id: nextId, kind: wire.kind, ...attempt }]
      : replace(queue, at, attempt);
  }

  // The link is up. It plays as an opener when nothing is on the bar and the
  // panel is not over it, or while the welcome it started is still playing - the
  // gate in App moves that one on when its minimum is up. Otherwise the link is
  // shown as it stands, which includes a connection that finished while the panel
  // was open or another indicator was ahead.
  const opening =
    before === undefined
      ? queue.length === 0 && !open
      : onScreen && before.net?.phase === "connecting";
  const link = {
    detail: event.detail,
    net: { phase: (opening ? "connecting" : "connected") as NetPhase, up: true },
  };
  // The link reported twice is the same news: leave the activity, and its clock,
  // exactly as they are.
  if (
    before !== undefined &&
    before.net?.phase === link.net.phase &&
    before.net.up &&
    before.detail === event.detail
  ) {
    return queue;
  }
  return before === undefined
    ? [...queue, { id: nextId, kind: wire.kind, ...link }]
    : replace(queue, at, link);
}

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
function useCountUp(value: number) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const started = performance.now();
    let frame = window.requestAnimationFrame(function step() {
      const progress = Math.min(1, (performance.now() - started) / COUNT_UP_MS);
      // Ease out: most of the trip happens early, then it settles on the level.
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = window.requestAnimationFrame(step);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return shown;
}

/**
 * Plugging in. The bolt draws itself in and then fills, a ring pulses out from
 * behind it, the level counts up, and the level's own 3px bar grows along the
 * bottom edge with a highlight travelling through it.
 *
 * It sits on its own layer rather than in the clock's 20px row, because it takes
 * the whole bar. Mounted per activity, so a second plug replays all of it.
 *
 * All of it plays on every machine. A system set to reduce motion asks for less,
 * but the arrival is the notch's whole personality and is over in a couple of
 * seconds, so the spec's accessibility carve-out was dropped after seeing it
 * land on the machine this is built on.
 */
function ChargingContent({ detail }: { detail: string }) {
  const percent = Number.parseInt(detail, 10);
  const level = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;
  const shown = useCountUp(level);

  return (
    <>
      <div className="notch-charging-row">
        <span className="notch-charging-bolt" aria-hidden="true">
          <motion.span
            className="notch-charging-ring"
            initial={{ scale: 1, opacity: 0.5 }}
            animate={{ scale: 1.9, opacity: 0 }}
            transition={PULSE_RING}
          />
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
              initial={{ pathLength: 0, fillOpacity: 0 }}
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
          initial={{ width: 0 }}
          animate={{ width: `${level}%` }}
          transition={LEVEL_FILL}
        >
          <span className="notch-charging-shimmer" />
        </motion.div>
      </div>
    </>
  );
}

/**
 * Wi-Fi and the cable. Both phases fill the charger's bar on the charger's
 * timings; what changes between them is the caption, the icon and the strip
 * along the bottom.
 *
 * The wording is Indonesian, like the rest of the notch. A Wi-Fi link names the
 * network it is on; the cable has nothing to name, so it says what the port
 * negotiated instead (native reads it from Windows, see `link_speed`).
 */
const NET_CAPTION: Record<
  NetKind,
  Record<NetPhase, (detail: string) => string>
> = {
  wifi: {
    connecting: () => "Menghubungkan…",
    connected: (ssid) => ssid || "Wi-Fi",
    failed: () => "Koneksi gagal",
    lost: () => "Koneksi terputus",
  },
  ethernet: {
    connecting: () => "Kabel terdeteksi",
    connected: () => "Ethernet",
    failed: () => "Koneksi gagal",
    lost: () => "Koneksi terputus",
  },
};

/**
 * The three arcs of a wireless glyph: paths of concentric circles centred below
 * the viewBox, each cut off 50 degrees either side of vertical.
 */
const WIFI_ARCS = [
  "M2.04 10.64 A13 13 0 0 1 21.96 10.64",
  "M5.11 13.21 A9 9 0 0 1 18.89 13.21",
  "M8.17 15.79 A5 5 0 0 1 15.83 15.79",
];

/** While the attempt is in flight, each arc blinks on its own beat. */
const ARC_BLINK: Transition = { duration: 1.1, ease: "easeInOut", repeat: Infinity };
const ARC_STEP = 0.18;

/** Four bars of increasing height, the way a signal meter reads. */
const SIGNAL_BARS = [5, 8, 11, 14];

/** The ethernet plug's slide into its port. */
const PLUG: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 17,
  delay: 0.1,
};
/** The icon's bounce when the link comes up. */
const ICON_POP: Transition = { type: "spring", stiffness: 420, damping: 16 };
/** Each signal bar rising into place, one after another. */
const BAR_SPRING: Transition = { type: "spring", stiffness: 500, damping: 22 };
const BAR_STEP = 0.07;
/** The ring that clicks out of the port once the cable lands. */
const CLICK_RING: Transition = { duration: 0.5, ease: "easeOut" };
/** The travelling segment that stands in for progress while connecting. */
const RUNNER: Transition = { duration: 1, ease: "easeInOut", repeat: Infinity };
/**
 * The link speed, which waits for the caption's own swap to finish (160ms out,
 * 160ms in) rather than shoving it sideways while it slides.
 */
const SPEED_IN: Transition = { duration: 0.25, delay: 0.3, ease: "easeOut" };
/** The caption swap: the old one up and out, the new one in from below. */
const CAPTION_SWAP: Transition = { duration: 0.16 };

/**
 * The icon's single bounce. Motion springs between two values only, so the
 * spec's 1 -> 1.18 -> 1 plays as two springs with the stiffness and damping it
 * names - out on the way up, and back with one visible bounce of its own.
 */
function Pop({ active, children }: { active: boolean; children: ReactNode }) {
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (!active) setBack(false);
  }, [active]);

  return (
    <motion.span
      className="notch-network-glyph"
      initial={{ scale: 1 }}
      animate={{ scale: active && !back ? 1.18 : 1 }}
      transition={ICON_POP}
      onAnimationComplete={() => {
        if (active) setBack(true);
      }}
    >
      {children}
    </motion.span>
  );
}

function WifiIcon({ phase }: { phase: NetPhase }) {
  const live = phase === "connected";
  // A notice is not a link: the arcs stop blinking and the meter goes, so the
  // icon reads as finished rather than as still trying.
  const quiet = phase === "failed" || phase === "lost";

  return (
    <span
      className="notch-network-icon"
      data-quiet={quiet || undefined}
      aria-hidden="true"
    >
      <Pop active={live}>
        <svg viewBox="0 0 24 24" className="notch-network-arcs">
          {WIFI_ARCS.map((d, index) => (
            <motion.path
              key={d}
              d={d}
              fill="none"
              stroke="#60a5fa"
              strokeWidth={2}
              strokeLinecap="round"
              initial={{ opacity: 0.15 }}
              animate={
                live
                  ? { opacity: 1 }
                  : quiet
                    ? { opacity: 0.5 }
                    : { opacity: [0.15, 1, 0.15] }
              }
              transition={
                live || quiet
                  ? { duration: 0.2 }
                  : { ...ARC_BLINK, delay: index * ARC_STEP }
              }
            />
          ))}
        </svg>
      </Pop>
      {/* The bars are the one part of the glyph the attempt does not have: a
          signal meter only means something once there is a signal. The space is
          held for them either way, so nothing shifts when they arrive. */}
      <span className="notch-network-bars">
        {live &&
          SIGNAL_BARS.map((height, index) => (
            <motion.span
              key={height}
              className="notch-network-bar"
              style={{ height }}
              initial={{ scaleY: 0.25, opacity: 0.3 }}
              animate={{ scaleY: 1, opacity: 1 }}
              transition={{ ...BAR_SPRING, delay: index * BAR_STEP }}
            />
          ))}
      </span>
    </span>
  );
}

function EthernetIcon({ phase }: { phase: NetPhase }) {
  const quiet = phase === "failed" || phase === "lost";

  return (
    <span
      className="notch-network-icon"
      data-quiet={quiet || undefined}
      aria-hidden="true"
    >
      {/* The plug slides in from the left; the ring clicks out of the port the
          moment the cable lands in it. */}
      <motion.span
        className="notch-network-plug"
        initial={{ x: -14 }}
        animate={{ x: 0 }}
        transition={PLUG}
      />
      <span className="notch-network-port">
        {phase === "connected" && (
          <motion.span
            className="notch-network-click"
            initial={{ scale: 1, opacity: 0.9 }}
            animate={{ scale: 1.5, opacity: 0 }}
            transition={CLICK_RING}
          />
        )}
      </span>
    </span>
  );
}

function NetworkContent({
  kind,
  phase,
  detail,
}: {
  kind: NetKind;
  phase: NetPhase;
  detail: string;
}) {
  const caption = NET_CAPTION[kind][phase](detail);
  // The cable's one thing to read is how fast the port negotiated, and native
  // leaves it empty when Windows will not say.
  const speed = kind === "ethernet" && phase === "connected" && detail;

  return (
    <>
      <div className="notch-network-row">
        {kind === "wifi" ? (
          <WifiIcon phase={phase} />
        ) : (
          <EthernetIcon phase={phase} />
        )}
        <span className="notch-network-title">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={caption}
              className="notch-network-caption"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={CAPTION_SWAP}
            >
              {caption}
            </motion.span>
          </AnimatePresence>
          {speed && (
            <motion.span
              className="notch-network-level"
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={SPEED_IN}
            >
              · {detail}
            </motion.span>
          )}
        </span>
      </div>
      {/* Nothing to measure while connecting, so the strip travels instead; once
          the link is up it fades out and leaves the bar clean. */}
      <AnimatePresence>
        {phase === "connecting" && (
          <motion.div
            key="attempt"
            className="notch-network-track"
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            <motion.div
              className="notch-network-runner"
              animate={{ x: ["-40%", "260%"] }}
              transition={RUNNER}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
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
  // Set between the charger's bar shrinking and the next indicator taking over.
  const [settling, setSettling] = useState(false);
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while a native call is in flight, which is what lets a fast reverse
  // cancel an open that has not started animating yet.
  const wanted = useRef(false);
  // The activity listener is mounted once and never re-subscribed, so it reads
  // the panel's state through a ref rather than closing over a stale value.
  const openRef = useRef(open);
  openRef.current = open;

  const activity = activities[0];
  // While the panel is open the indicator waits rather than interrupting: it
  // lives on the collapsed bar, so showing it would mean closing what the user
  // just opened. The queue is held, not dropped.
  const showingActivity = activity !== undefined && !open;
  // The two tall indicators: the charger's arrival and a network coming up. The
  // "unplugged" notice and the rest stay on the clock's small bar.
  const charging = showingActivity && activity.kind === "power-connected";
  const network =
    showingActivity && activity !== undefined ? networkOf(activity) : undefined;
  const tall = charging || network !== undefined;
  // What the clock's row shows. The tall indicators are not part of it - they
  // have layers of their own - and while the bar is settling after one, nothing
  // is.
  const rowActivity =
    showingActivity && !settling && !tall && activity !== undefined && isRow(activity.kind)
      ? activity
      : undefined;
  // An indicator is worth showing even when autohide would have hidden the
  // notch; once it has had its turn the autohide state takes over again.
  // Reporting it as *visible* to native matters: the hook then treats it as a
  // notch again, so it can still be clicked open.
  const hidden = autohide && !showingActivity;

  // Which shape the bar is in.
  const bar: Bar = open ? "panel" : tall ? "tall" : "bar";

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
  const silhouette = bar === "bar" && hidden ? { ...COLLAPSED, height: 0 } : BAR_SIZES[bar];

  /**
   * The bar always springs between its shapes: growing into the panel or into the
   * charger's bar uses the expand spring, and every return - the charger's, the
   * panel's, autohide sliding the bar away - uses the collapse one. Nothing here
   * consults `prefers-reduced-motion`: the arrival is the notch's personality and
   * plays on every machine, including the one this is built on, which asks for
   * reduced motion and had been getting a bar that simply jumped.
   */
  const sizeTransition: Transition = bar === "bar" ? SPRING_CLOSE : SPRING_OPEN;
  // Content Blur Fade-In / Fade-Out for the tall indicators: 8px of blur and a
  // 0.95 scale behind a 250ms fade that starts 80ms after the bar begins to grow.
  // The same timings the panel's own content uses.
  const arrivalEnter: Transition = {
    duration: 0.25,
    delay: 0.08,
    ease: "easeOut",
  };
  const arrivalExit: Transition = { duration: 0.12 };

  const setHitArea = useCallback(async (state: Bar) => {
    const size = BAR_SIZES[state];
    try {
      await invoke("set_notch_hit", {
        width: size.width,
        height: size.height,
        // The tall bar is still a bar to click open, not a panel: only the
        // expanded panel wants the window itself interactive.
        clickThrough: state !== "panel",
      });
    } catch (err) {
      console.error("set_notch_hit failed:", err);
    }
  }, []);

  const openPanel = useCallback(async () => {
    wanted.current = true;
    // Stop passing clicks through before the notch starts growing, otherwise
    // the panel would be click-through while it animates in.
    await setHitArea("panel");
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
    // depends on what is on the bar: a tall one is wider than the clock's.
    if (!wanted.current) void setHitArea(bar);
  }, [setHitArea, bar]);

  // Re-assert the collapsed state as soon as the webview is alive.
  useEffect(() => {
    void setHitArea("bar");
  }, [setHitArea]);

  // Native has to guard the tall bar's own rect *before* it starts growing, or
  // the hook would still be watching the smaller one while the bar is already
  // wider than it and clicks near its corners would fall through.
  useEffect(() => {
    if (tall) void setHitArea("tall");
  }, [tall, setHitArea]);

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

  // Charger, networks, Bluetooth and USB, detected natively.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<WireEvent>("notch-activity", (event) => {
      const id = nextActivityId.current++;
      setActivities((queue) =>
        queue.length >= ACTIVITY_QUEUE_MAX
          ? queue
          : enqueue(queue, event.payload, openRef.current, id),
      );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  /** Drops the activity at the head of the queue. */
  const popActivity = useCallback(() => {
    setActivities((queue) => queue.slice(1));
  }, []);

  /**
   * The same, for the indicators that took the tall bar: the bar is left to
   * shrink back to the clock's size on its own before the next activity takes
   * its place, so nothing appears inside a bar that is still collapsing.
   */
  const popTall = useCallback(() => {
    popActivity();
    setSettling(true);
    window.setTimeout(() => setSettling(false), SETTLE_MS);
  }, [popActivity]);

  /** Moves the indicator on the bar from one of its phases to the next. */
  const advanceNetwork = useCallback((phase: NetPhase, up: boolean) => {
    setActivities((queue) =>
      queue.map((item, index) =>
        index === 0 && item.net !== undefined
          ? { ...item, net: { phase, up } }
          : item,
      ),
    );
  }, []);

  /**
   * When the network's intro phase went on screen. Its minimum is measured from
   * there, and closing the panel starts it over, the same way the charger's dwell
   * does.
   */
  const introAt = useRef(0);
  useEffect(() => {
    introAt.current = performance.now();
  }, [activity?.id, activity?.net?.phase, open]);

  /**
   * One activity at a time, then the next. The timers only run while the activity
   * is actually on screen: opening the panel pauses them, so an indicator cannot
   * burn its time behind an open panel, and closing the panel gives the one still
   * showing a fresh turn.
   *
   * The charger gets longer than the rest because it has an animation to play,
   * and once it is over the bar is left to shrink back on its own.
   *
   * The networks are not a plain dwell. Their intro phase is a minimum rather
   * than a length: the indicator stays on the bar until the network answers, and
   * only then - once the minimum has had its time - moves to the link. A machine
   * that never answers at all is what the give-up guard is for.
   */
  useEffect(() => {
    if (activity === undefined || open || settling) return;

    const net = networkOf(activity);
    if (net === undefined) {
      const timer = window.setTimeout(
        charging ? popTall : popActivity,
        charging ? POWER_MS : ACTIVITY_MS,
      );
      return () => window.clearTimeout(timer);
    }

    if (net.phase === "connecting") {
      if (!net.up) {
        const timer = window.setTimeout(
          () => advanceNetwork("failed", false),
          NET_GIVE_UP_MS,
        );
        return () => window.clearTimeout(timer);
      }
      // The link is up: wait out whatever is left of the intro's minimum.
      const left = Math.max(
        0,
        introAt.current + NET_INTRO_MS[net.kind] - performance.now(),
      );
      const timer = window.setTimeout(
        () => advanceNetwork("connected", true),
        left,
      );
      return () => window.clearTimeout(timer);
    }

    const timer = window.setTimeout(
      popTall,
      net.phase === "connected" ? NET_LINK_MS : NET_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activity, open, settling, charging, popActivity, popTall, advanceNetwork]);

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
      {/* The tall indicators cast a glow from a layer of its own: the shell clips
          itself - which is what keeps the ears tidy and slides the bar out of
          sight on autohide - and a clip-path would cut the shadow off with it.
          The charger glows green from the moment it arrives; the network glows
          blue, but only once it is actually up. */}
      <motion.div
        aria-hidden="true"
        initial={false}
        animate={{
          width: silhouette.width,
          height: silhouette.height,
          borderBottomLeftRadius: silhouette.radius,
          borderBottomRightRadius: silhouette.radius,
          opacity: charging || network?.phase === "connected" ? 1 : 0,
        }}
        transition={{
          ...sizeTransition,
          opacity: { duration: 0.2 },
        }}
        data-tone={network ? "network" : "power"}
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
                    if (!isRow(rowActivity.kind)) return null;
                    const look = ROW[rowActivity.kind];
                    const power = rowActivity.kind === "power-disconnected";
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
              ) : tall || settling ? null : (
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
          {/* Plugging in takes the whole bar rather than the clock's 20px row, so
              it is a layer of its own - and keyed per activity, so a second plug
              replays the arrival from the start. */}
          <AnimatePresence>
            {charging && (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
                className="notch-charging"
              >
                <ChargingContent detail={activity.detail} />
              </motion.div>
            )}
          </AnimatePresence>
          {/* A network takes the same bar. One activity covers both its phases,
              so the layer stays mounted from the attempt to the link and only
              what it holds changes - see `NetworkContent`. */}
          <AnimatePresence>
            {network && activity !== undefined && (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
                data-phase={network.phase}
                className="notch-network"
              >
                <NetworkContent
                  kind={network.kind}
                  phase={network.phase}
                  detail={network.detail}
                />
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
