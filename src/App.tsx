import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Transition } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  foldUsb,
  isUsbKind,
  USB_READING_MS,
  USB_READY_MS,
  USB_REMOVED_MS,
  USB_TIMEOUT_MS,
} from "./usb";
import type { UsbPayload, UsbState, UsbPhase } from "./usb";
import { UsbContent } from "./UsbContent";
import { BluetoothContent } from "./BluetoothContent";
import { Panel } from "./Panel";
import { useNook } from "./useNook";
import { CollapsedClock } from "./CollapsedClock";
import type { TabId } from "./tabs";
import { BT_CONNECTING_MS, BT_CONNECTED_MS, foldBluetooth, isBluetoothKind } from "./bluetooth";
import type { BluetoothPayload, BluetoothState } from "./bluetooth";
import { useCoverAccent } from "./accent";
import { HudContent } from "./HudContent";
import type { HudView } from "./HudContent";
import { HUD_HOLD_MS } from "./hud";

/**
 * Foundation prototype: a notch that opens, closes and settles cleanly.
 *
 * Three sizes, all sharing one spring per direction. Every future tab will reuse
 * EXPANDED so the geometry never changes between tabs, and both the size and the
 * bottom corner radius run off the same animation.
 */
const COLLAPSED = { width: 200, height: 34, radius: 14, ear: 6 };
/**
 * The keyboard HUD: a shorter, wider bar than the charger's, with the rounder
 * 22px corners and 12px ears the spec asks for. It holds one row - icon, bar,
 * percentage - inset 20px from each side.
 */
const HUD = { width: 300, height: 46, radius: 22, ear: 12 };
/**
 * The indicators that take the whole bar - the charger's arrival and a network
 * coming up - share this shape: wider and taller than the clock's bar, and
 * rounder to match. The main panel is not involved.
 */
const TALL = { width: 300, height: 52, radius: 24, ear: 14 };
/**
 * The open panel follows Boring Notch's proportions: a 640px-wide black slab
 * with a 24px bottom corner, a slim header row and one 148px content band. The
 * media block keeps the reference's 352px so the artwork has room to breathe;
 * the widget stack keeps its fixed 252px.
 *
 * Pinning a widget widens the shell by the compact column (100) and its gap
 * (12), exactly as before, so the stack itself never resizes.
 */
const EXPANDED = { width: 640, height: 200, radius: 24, ear: 14 };
const EXPANDED_WIDE = { width: 752, height: 200, radius: 24, ear: 14 };

/**
 * The three shapes the bar can be in. The destination is what picks the spring -
 * growing into the panel or into the tall bar springs open, shrinking back to
 * the clock's bar springs shut - so the shape is named separately from its size.
 */
type Bar = "bar" | "tall" | "hud" | "panel";
const BAR_SIZES: Record<Bar, typeof COLLAPSED> = {
  bar: COLLAPSED,
  tall: TALL,
  hud: HUD,
  panel: EXPANDED,
};

/**
 * Boring Notch's springs, expressed for Motion. Opening is close to the
 * reference's interactive spring (response ~0.36s, damping fraction ~0.8):
 * quick enough to feel pressed, with a whisper of overshoot instead of a
 * bounce. Closing is the same shape, critically damped, so the slab settles
 * flat.
 *
 * The window keeps transparent margins because the spring overshoots by a few
 * percent of the distance travelled.
 */
const SPRING_OPEN: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 28,
  mass: 1,
};
const SPRING_CLOSE: Transition = { type: "spring", stiffness: 320, damping: 36 };
/**
 * The HUD has its own, quicker pair: it should feel like a heads-up readout
 * rather than the panel's deliberate arrival. Reduced motion turns both into a
 * short, non-overshooting size change.
 */
const HUD_OPEN: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 26,
  mass: 0.9,
};
const HUD_CLOSE: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 40,
};
const HUD_REDUCED: Transition = { duration: 0.16, ease: "easeOut" };

/**
 * Content Blur Fade-In / Content Blur Fade-Out. The fade-in starts 80ms after
 * the press so the panel has already opened up behind it; the fade-out is
 * deliberately quick, because the panel is shrinking under it at the same time.
 */
const CONTENT_ENTER: Transition = { duration: 0.25, delay: 0.08, ease: "easeOut" };

/**
 * The body fades and rises into place after the slab has begun to open, which
 * is the reference's `.scale(anchor: .top) + opacity` entrance. It is slower
 * than the shell so the content lands rather than snaps.
 */
const PANEL_ENTER: Transition = { duration: 0.32, delay: 0.05, ease: "easeOut" };
const PANEL_EXIT: Transition = { duration: 0.12 };

/**
 * The idle clock: `HH:mm`, 24-hour local time, exactly as the WPF original
 * formatted it. Built by hand rather than through Intl so the two-digit shape
 * survives a machine whose locale formats hours its own way.
 */
const formatClock = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/**
 * Native detects activity (see `activity.rs`); each source takes the clock's
 * place in turn. USB, Bluetooth and networks have phases; power has a dwell.
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

type WireEvent = {
  kind: WireKind | "usb-ready" | "bluetooth-updated" | "bluetooth-disconnected";
  detail: string;
  usb?: UsbPayload;
  bluetooth?: BluetoothPayload;
};

/** What `keyboard.rs` reports after it has written and re-read the endpoint. */
type HudVolume = {
  level: number;
  muted: boolean;
  limited: boolean;
  failed: boolean;
};

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
  usb?: UsbState;
  bluetooth?: BluetoothState;
};

/**
 * How long each of the tall indicators holds the bar, counted from the first
 * frame of its arrival - the same way the charger's own clock has always run.
 *
 * The charger is the longest thing the notch does: there is a bolt to draw, a
 * level to count up and a bar to fill. Taking the cable out has that bar but
 * nothing to wait for, so it is over sooner.
 */
const TALL_MS: Partial<Record<ActivityKind, number>> = {
  "power-connected": 3500,
  "power-disconnected": 2400,
};
/**
 * A beat between a tall indicator's bar shrinking and the next one appearing: the
 * bar goes back to the clock's size first, with nothing on it, rather than the
 * next activity showing up inside a bar that is still collapsing.
 */
const SETTLE_MS = 460;
/** Guard against a device flapping faster than the queue can drain. */
const ACTIVITY_QUEUE_MAX = 8;

/**
 * Controls whose own mouse semantics must survive the shell's press handler.
 * A ranged input in particular only moves while the browser still owns its
 * mousedown; `preventDefault()` there freezes the thumb at its old value.
 */
function isNativeControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, option, [contenteditable='true']") !== null
  );
}

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
 * Taking the cable out, in seconds. The bolt is not drawn this time - it is
 * already there, full and green - so it shakes, and then goes out: the fill
 * fades away and the stroke turns grey.
 */
const BOLT_SHAKE: Transition = { duration: 0.35, delay: 0.25, ease: "easeInOut" };
const BOLT_OUT: Transition = { duration: 0.25, delay: 0.3, ease: "easeOut" };
/**
 * The ring runs the other way here: it starts wide and faint where the arrival's
 * ring ended, and collapses behind the bolt as it goes out.
 */
const RING_IN: Transition = { duration: 0.45, delay: 0.25, ease: "easeIn" };
/** The level's bar: it is already the right width, so only its colour moves. */
const LEVEL_TINT: Transition = { duration: 0.4, delay: 0.3, ease: "easeOut" };
const LEVEL_SHOW: Transition = { duration: 0.2, ease: "easeOut" };

/** Where a level stops being white and starts being worth a warning. */
const LOW_BATTERY = 20;

/**
 * The bolt is drawn rather than typed: it has to be a real path so the stroke can
 * draw itself in (`pathLength`) and the fill can arrive afterwards, which the
 * emoji could not do.
 */
const BOLT_PATH = "M12.6 2.4 5.2 13.4h5.9l-.5 8.2 8.6-11.3h-6.3z";

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
 * Networks and USB fold several native events into one activity with phases.
 * USB additionally uses an attachment identity so removal cancels only its own
 * arrival, including one still waiting behind another indicator.
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
  if (isBluetoothKind(event.kind)) {
    if (!event.bluetooth?.deviceId) return queue;
    return foldBluetooth(queue, { ...event, kind: event.kind, bluetooth: event.bluetooth }, nextId);
  }
  if (isUsbKind(event.kind)) {
    // USB metadata/removals must carry the same native attachment identity.
    // Reject malformed replies instead of associating two equal product names.
    if (!event.usb?.deviceId) return queue;
    return foldUsb(queue, { ...event, kind: event.kind, usb: event.usb }, nextId);
  }
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
 * Taking the cable out. The arrival's bar, and then the bolt it just drew, going
 * out: a shake, the green fill draining away while the stroke turns grey, and the
 * ring behind it collapsing inwards instead of pulsing outwards.
 *
 * Nothing counts up and nothing grows here. The battery is whatever it is, so the
 * percentage is simply shown and the bar along the bottom is already that wide -
 * it only has to change colour, to grey, or to amber if the level is low.
 *
 * A machine that will not report a level - a desktop, where Windows leaves the
 * field at 255 - gets the notice without one, because the alternative is "0%",
 * which is a number and a wrong one.
 *
 * Reduced motion is ignored, exactly as it is for the arrival.
 */
function UnpluggedContent({ detail }: { detail: string }) {
  const percent = Number.parseInt(detail, 10);
  const known = Number.isFinite(percent);
  const level = known ? Math.max(0, Math.min(100, percent)) : 0;
  const low = known && level <= LOW_BATTERY;

  return (
    <>
      <div className="notch-unplugged-row">
        <span className="notch-unplugged-bolt" aria-hidden="true">
          <motion.span
            className="notch-unplugged-ring"
            initial={{ scale: 1.9, opacity: 0.45 }}
            animate={{ scale: 0.8, opacity: 0 }}
            transition={RING_IN}
          />
          <motion.svg
            viewBox="0 0 24 24"
            className="notch-unplugged-bolt-svg"
            aria-hidden="true"
            initial={{ x: 0 }}
            animate={{ x: [0, -3, 3, -2, 2, 0] }}
            transition={BOLT_SHAKE}
          >
            <motion.path
              d={BOLT_PATH}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ fill: "#34d399", stroke: "#34d399" }}
              animate={{ fill: "rgba(52, 211, 153, 0)", stroke: "#9ca3af" }}
              transition={BOLT_OUT}
            />
          </motion.svg>
        </span>
        <span className="notch-unplugged-title">
          Charger dilepas
          {known && (
            <span className="notch-unplugged-level" data-low={low || undefined}>
              {` · ${level}%`}
            </span>
          )}
        </span>
      </div>
      {known && (
        <div className="notch-unplugged-track">
          <motion.div
            className="notch-unplugged-fill"
            style={{ width: `${level}%` }}
            initial={{ opacity: 0, backgroundColor: "#34d399" }}
            animate={{
              opacity: 1,
              backgroundColor: low ? "#f59e0b" : "#6b7280",
            }}
            transition={{ opacity: LEVEL_SHOW, backgroundColor: LEVEL_TINT }}
          />
        </div>
      )}
    </>
  );
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
  const live = phase === "connected";

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
        {/* The signal meter, out at the bar's other end. Wi-Fi is the only one
            with a signal to measure, and only once it has one. */}
        <span className="notch-network-meter" aria-hidden="true">
          {kind === "wifi" && live && (
            <span className="notch-network-bars">
              {SIGNAL_BARS.map((height, index) => (
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
  // Retain the model and last tab when the animated panel view unmounts.
  const [activeTab, setActiveTab] = useState<TabId>("nook");
  const nook = useNook(open);
  const mediaPlaying = nook.media?.playing === true;
  const coverAccent = useCoverAccent(nook.media?.thumbnail);
  // True while a foreground window covers the collapsed notch (native monitors
  // it, see the autohide module in lib.rs). Autohide never applies to the open
  // panel, so hidden and open are mutually exclusive in practice.
  const [autohide, setAutohide] = useState(false);
  // Activities are queued and shown one at a time, oldest first.
  const [activities, setActivities] = useState<Activity[]>([]);
  const nextActivityId = useRef(0);
  // Set between the charger's bar shrinking and the next indicator taking over.
  const [settling, setSettling] = useState(false);
  // The keyboard HUD is a temporary reading, not a queued activity: the newest
  // key press simply replaces what is on the bar and restarts its 1600ms hold.
  const [hud, setHud] = useState<HudView | null>(null);
  const [hudPulse, setHudPulse] = useState(0);
  const [hudLimit, setHudLimit] = useState(0);
  const hudTimer = useRef<number | null>(null);
  const hudOn = hud !== null;
  // Derive width from retained state so reopening a pinned Nook grows directly
  // to its wide silhouette, without an intermediate narrow frame/hit rectangle.
  const wide = open && activeTab === "nook" && nook.pinned.length > 0;
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while a native call is in flight, which is what lets a fast reverse
  // cancel an open that has not started animating yet.
  const wanted = useRef(false);
  // The activity listener is mounted once and never re-subscribed, so it reads
  // the panel's state through a ref rather than closing over a stale value.
  const openRef = useRef(open);
  openRef.current = open;

  const clearHudTimer = useCallback(() => {
    if (hudTimer.current !== null) {
      window.clearTimeout(hudTimer.current);
      hudTimer.current = null;
    }
  }, []);

  /**
   * Show one HUD reading and push its collapse back to 1600ms from this press.
   * The panel is never closed for a HUD: if the user is already reading the
   * panel, the reading waits (the next one, after it closes, will show).
   */
  const showHud = useCallback(
    (next: HudView, limited = false) => {
      if (openRef.current) return;
      setHud(next);
      setHudPulse((count) => count + 1);
      if (limited) setHudLimit((count) => count + 1);
      clearHudTimer();
      hudTimer.current = window.setTimeout(() => {
        hudTimer.current = null;
        setHud(null);
      }, HUD_HOLD_MS);
    },
    [clearHudTimer],
  );

  // Opening the panel takes the bar for itself; a reading that was already
  // counting down would otherwise reappear when the panel closes.
  useEffect(() => {
    if (!open) return;
    clearHudTimer();
    setHud(null);
  }, [open, clearHudTimer]);

  useEffect(
    () => () => {
      clearHudTimer();
    },
    [clearHudTimer],
  );

  // Volume steps arrive already applied and re-read by `keyboard.rs`; this
  // side only decides when the HUD has had its time on screen.
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const attach = <T,>(name: string, handler: (payload: T) => void) => {
      void listen<T>(name, (event) => handler(event.payload)).then((unlisten) => {
        if (disposed) unlisten();
        else stops.push(unlisten);
      });
    };
    attach<HudVolume>("hud-volume", (event) =>
      showHud(
        {
          kind: "volume",
          level: event.level,
          muted: event.muted,
          failed: event.failed,
        },
        event.limited,
      ),
    );
    // The brightness keys are handled by the ASUS firmware; this event is the
    // panel's own new level, observed after the fact.
    attach<number>("hud-brightness", (level) =>
      showHud({ kind: "brightness", level, failed: false }),
    );
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [showHud]);

  const activity = activities[0];
  // While the panel is open the indicator waits rather than interrupting: it
  // lives on the collapsed bar, so showing it would mean closing what the user
  // just opened. The queue is held, not dropped. The HUD is a shorter pause:
  // an activity arriving mid-reading simply waits for the bar to come back.
  const showingActivity = activity !== undefined && !open && !settling && !hudOn;
  // All activity sources now take the tall bar; only the idle clock is small.
  const charging = showingActivity && activity.kind === "power-connected";
  const unplugged = showingActivity && activity.kind === "power-disconnected";
  const network =
    showingActivity && activity !== undefined ? networkOf(activity) : undefined;
  const usb = showingActivity ? activity.usb : undefined;
  const bluetooth = showingActivity ? activity.bluetooth : undefined;
  const tall = charging || unplugged || network !== undefined || usb !== undefined || bluetooth !== undefined;
  // An indicator is worth showing even when autohide would have hidden the
  // notch; once it has had its turn the autohide state takes over again.
  // Reporting it as *visible* to native matters: the hook then treats it as a
  // notch again, so it can still be clicked open. A HUD reading does the same:
  // the user just pressed a key and expects to see the answer.
  const hidden = autohide && !showingActivity && !hudOn;

  // Which shape the bar is in.
  const bar: Bar = open ? "panel" : hud ? "hud" : tall ? "tall" : "bar";

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
  const silhouette = bar === "bar" && hidden
    ? { ...COLLAPSED, height: 0 }
    : bar === "panel" && wide
      ? EXPANDED_WIDE
      : BAR_SIZES[bar];

  /**
   * The bar always springs between its shapes: growing into the panel or into the
   * charger's bar uses the expand spring, and every return - the charger's, the
   * panel's, autohide sliding the bar away - uses the collapse one. The HUD is
   * the one shape with its own quicker pair, and the one the reduced-motion
   * preference is allowed to turn into a plain size change; the rest of the
   * notch keeps its personality on every machine.
   */
  const previousBar = useRef<Bar>(bar);
  useEffect(() => {
    previousBar.current = bar;
  }, [bar]);
  const reducedMotion = useReducedMotion() ?? false;
  const hudTransition =
    bar === "hud"
      ? reducedMotion
        ? HUD_REDUCED
        : HUD_OPEN
      : previousBar.current === "hud" && bar === "bar"
        ? reducedMotion
          ? HUD_REDUCED
          : HUD_CLOSE
        : undefined;
  const sizeTransition: Transition =
    hudTransition ?? (bar === "bar" ? SPRING_CLOSE : SPRING_OPEN);
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

  useEffect(() => {
    if (!open) return;
    const size = wide ? EXPANDED_WIDE : EXPANDED;
    void invoke("set_notch_hit", {
      width: size.width,
      height: size.height,
      clickThrough: false,
    }).catch((err) => console.error("set_notch_hit failed:", err));
  }, [open, wide]);

  const openPanel = useCallback(async () => {
    wanted.current = true;
    // Stop passing clicks through before the notch starts growing, otherwise
    // the panel would be click-through while it animates in.
    const size = activeTab === "nook" && nook.pinned.length > 0 ? EXPANDED_WIDE : EXPANDED;
    try {
      await invoke("set_notch_hit", { width: size.width, height: size.height, clickThrough: false });
    } catch (err) {
      console.error("set_notch_hit failed:", err);
    }
    if (!wanted.current) return; // reversed while the call was in flight
    setOpen(true);
  }, [activeTab, nook.pinned.length]);

  const closePanel = useCallback(() => {
    wanted.current = false;
    setOpen(false);
    // Immediately tell native that hit area is back to collapsed bar size
    // so autohide check doesn't use the large expanded rectangle during collapse animation.
    void setHitArea(bar === "tall" ? "tall" : bar === "hud" ? "hud" : "bar");
  }, [setHitArea, bar]);

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

  // The HUD expands before its content is drawn, so the hook must already know
  // the wider rect when the first key press lands. Like the tall bar it stays
  // click-through: a click on it still opens the panel.
  useEffect(() => {
    if (hudOn) void setHitArea("hud");
  }, [hudOn, setHitArea]);

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
      // The bound applies to new arrivals, not metadata/removals for an existing
      // attachment. A full queue must never swallow a cancellation.
      setActivities((queue) =>
        enqueue(queue, event.payload, openRef.current, id).slice(0, ACTIVITY_QUEUE_MAX),
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

  const advanceUsb = useCallback((id: number, phase: UsbPhase) => {
    setActivities((queue) => queue.map((item) =>
      item.id === id && item.usb ? { ...item, usb: { ...item.usb, phase } } : item,
    ));
  }, []);

  const advanceBluetooth = useCallback((id: number) => {
    setActivities((queue) => queue.map((item) =>
      item.id === id && item.bluetooth?.phase === "connecting"
        ? { ...item, bluetooth: { ...item.bluetooth, phase: "connected" } } : item,
    ));
  }, []);

  /**
   * When the network's intro phase went on screen. Its minimum is measured from
   * there, and closing the panel starts it over, the same way the charger's dwell
   * does.
   */
  const introAt = useRef(0);
  useEffect(() => {
    introAt.current = performance.now();
  }, [activity?.id, activity?.net?.phase, activity?.usb?.phase, activity?.bluetooth?.phase, open, settling, hudOn]);

  /**
   * One activity at a time, then the next. The timers only run while the activity
   * is actually on screen: opening the panel pauses them, so an indicator cannot
   * burn its time behind an open panel, and closing the panel gives the one still
   * showing a fresh turn.
   *
   * A tall indicator holds the bar for its own length (see `TALL_MS`), and once
   * it is over the bar is left to shrink back on its own.
   *
   * The networks are not a plain dwell. Their intro phase is a minimum rather
   * than a length: the indicator stays on the bar until the network answers, and
   * only then - once the minimum has had its time - moves to the link. A machine
   * that never answers at all is what the give-up guard is for.
   */
  useEffect(() => {
    if (activity?.bluetooth?.phase === "cancelled") {
      // No disconnect notice. Collapse before handing the bar to another item;
      // a cancellation hidden behind the panel/settle can simply leave the queue.
      if (open || settling) popActivity();
      else popTall();
      return;
    }
    if (activity === undefined || open || settling || hudOn) return;

    if (activity.bluetooth) {
      const connecting = activity.bluetooth.phase === "connecting";
      const left = Math.max(0, introAt.current + (connecting ? BT_CONNECTING_MS : BT_CONNECTED_MS) - performance.now());
      const timer = window.setTimeout(connecting ? () => advanceBluetooth(activity.id) : popTall, left);
      return () => window.clearTimeout(timer);
    }

    if (activity.usb) {
      const state = activity.usb;
      let timer: number;
      if (state.phase === "reading") {
        // Metadata may have arrived while this attachment was queued. It still
        // gets its 800ms opener, but never pretends a disk has answered earlier.
        const deadline = introAt.current + (state.ready ? USB_READING_MS : USB_TIMEOUT_MS);
        timer = window.setTimeout(
          () => advanceUsb(activity.id, "ready"),
          Math.max(0, deadline - performance.now()),
        );
      } else {
        timer = window.setTimeout(popTall, state.phase === "ready" ? USB_READY_MS : USB_REMOVED_MS);
      }
      return () => window.clearTimeout(timer);
    }

    const net = networkOf(activity);
    if (net === undefined) {
      const hold = TALL_MS[activity.kind];
      const timer = window.setTimeout(popTall, hold ?? 0);
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
  }, [activity, open, settling, charging, hudOn, popActivity, popTall, advanceNetwork, advanceUsb, advanceBluetooth]);

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
          opacity: charging || network?.phase === "connected" || usb?.phase === "ready" || bluetooth?.phase === "connected" ? 1 : 0,
        }}
        transition={{
          ...sizeTransition,
          opacity: { duration: 0.2 },
        }}
        data-tone={bluetooth ? "bluetooth" : usb ? "usb" : network ? "network" : "power"}
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
          // A press on a real control belongs to that control. Cancelling the
          // native mousedown would keep a range input's thumb from following
          // the pointer, which makes the Quick Settings sliders look dead.
          if (isNativeControl(event.target)) return;
          event.preventDefault();
          pressNotch();
        }}
        onContextMenu={(event) => {
          // Suppress the webview's own menu and show the notch menu instead.
          event.preventDefault();
          void showMenu();
        }}
        onKeyDown={(event) => {
          // Enter/Space belong to focused child controls, not the shell.
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          pressNotch();
        }}
        className="notch-shell absolute top-0 left-1/2 -translate-x-1/2 outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      >
        <div
          className="notch-body"
          style={
            open && coverAccent
              ? ({
                  "--cover-accent": coverAccent,
                } as React.CSSProperties)
              : undefined
          }
        >
          {/* Ambient gradient layer based on media cover when expanded */}
          <div
            className="notch-cover-gradient pointer-events-none absolute inset-0"
            data-active={open && !!coverAccent}
            aria-hidden="true"
          />
          {/* The clock and the content are separate layers: neither can push the
              other around while one fades in and the other out, and the clock
              is vertically centred in the 34px bar. It fades into the panel as
              it opens rather than overlapping it. */}
          <motion.div
            aria-hidden={open || hudOn}
            initial={false}
            animate={{
              opacity: open || hudOn ? 0 : 1,
              filter: open || hudOn ? "blur(6px)" : "blur(0px)",
              scale: open || hudOn ? 0.95 : 1,
            }}
            transition={open || hudOn ? PANEL_EXIT : CONTENT_ENTER}
            className="notch-clock pointer-events-none absolute inset-x-0"
          >
            {/* One indicator at a time takes the clock's place; the WPF original
                kept the clock and put the activity beside it, but the clock is
                what this notch shows when it has nothing to say. */}
            <AnimatePresence mode="wait" initial={false}>
              {tall || settling || hudOn ? null : (
                <motion.div
                  key="clock"
                  initial={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                  exit={{ opacity: 0, filter: "blur(6px)", scale: 0.95 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <CollapsedClock
                    time={time}
                    pomodoro={nook.pomodoro}
                    playing={mediaPlaying}
                    thumbnail={nook.media?.thumbnail}
                    visible={!open && !hudOn}
                  />
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
          {/* Taking the cable out takes the same bar as putting it in, with the
              bolt that was just drawing itself going out instead. */}
          <AnimatePresence>
            {unplugged && (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
                className="notch-unplugged"
              >
                <UnpluggedContent detail={activity.detail} />
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
          <AnimatePresence>
            {usb && (
              <motion.div
                key={activity.id}
                className="notch-usb"
                data-phase={usb.phase}
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
              >
                <UsbContent usb={usb} detail={activity.detail} />
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {bluetooth && bluetooth.phase !== "cancelled" && (
              <motion.div
                key={activity.id}
                className="notch-bluetooth"
                data-phase={bluetooth.phase}
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
              >
                <BluetoothContent bluetooth={bluetooth} detail={activity.detail} />
              </motion.div>
            )}
          </AnimatePresence>
          {/* The keyboard HUD. It is a layer of its own so a key press can
              replace the clock (or wait out an activity) without touching the
              shell: the 300x46 silhouette and its ears are App's animation. */}
          <AnimatePresence>
            {hud && (
              <motion.div
                key="hud"
                className="notch-hud-layer"
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.95 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: arrivalExit }}
                transition={arrivalEnter}
              >
                <HudContent hud={hud} pulse={hudPulse} limit={hudLimit} />
              </motion.div>
            )}
          </AnimatePresence>
          {/* The open panel: nav bar plus the active tab's (still empty)
              content. Enters late and small-blurred, exits quickly, exactly
              like the clock row above it did when it was a placeholder. */}
          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.92, y: -6 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1, y: 0 }}
                exit={{ opacity: 0, filter: "blur(6px)", transition: PANEL_EXIT }}
                transition={PANEL_ENTER}
                className="notch-panel"
              >
                <Panel active={activeTab} onTab={setActiveTab} nook={nook} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
