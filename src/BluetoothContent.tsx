import { memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Transition } from "framer-motion";
import { batteryLevel } from "./bluetooth";
import type { BluetoothState } from "./bluetooth";

const DRAW: Transition = { duration: 0.6, delay: 0.15, ease: "easeInOut" };
const RADAR: Transition = { duration: 1.2, repeat: Infinity, ease: "easeOut" };
const RIPPLE: Transition = { duration: 0.6, ease: "easeOut" };
const POP: Transition = { duration: 0.35, ease: "easeOut" };
const BATTERY_FILL: Transition = { type: "spring", stiffness: 260, damping: 24, delay: 0.12 };
const ICON_POP = { scale: [1, 1.25, 1] };
const ICON_REST = { scale: 1 };

// Battery/name updates must not replay the once-only icon bounce.
const BluetoothIcon = memo(function BluetoothIcon({ connected }: { connected: boolean }) {
  return (
    <span className="notch-bluetooth-icon" aria-hidden="true">
      {!connected && [0, 1].map((ring) => (
        <motion.span
          key={ring}
          className="notch-bluetooth-radar"
          initial={{ scale: 0.6, opacity: 0.5 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ ...RADAR, delay: ring * 0.6 }}
        />
      ))}
      {connected && (
        <motion.span
          className="notch-bluetooth-ripple"
          initial={{ scale: 0.6, opacity: 0.6 }}
          animate={{ scale: 1.9, opacity: 0 }}
          transition={RIPPLE}
        />
      )}
      <motion.svg
        className="notch-bluetooth-glyph"
        viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={1.9}
        strokeLinecap="round" strokeLinejoin="round"
        initial={false}
        animate={connected ? ICON_POP : ICON_REST}
        transition={POP}
      >
        <motion.path
          d="m6 7 12 10-6 5V2l6 5L6 17"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={DRAW}
        />
      </motion.svg>
    </span>
  );
});

export function BluetoothContent({ bluetooth, detail }: { bluetooth: BluetoothState; detail: string }) {
  const connected = bluetooth.phase === "connected";
  const level = connected ? batteryLevel(bluetooth.batteryPercent) : undefined;
  const caption = connected ? detail.trim() || "Perangkat Bluetooth" : "Menghubungkan…";

  return (
    <div className="notch-bluetooth-row">
      <BluetoothIcon connected={connected} />
      <span className="notch-bluetooth-title">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={bluetooth.phase}
            className="notch-bluetooth-caption"
            title={caption}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
          >{caption}</motion.span>
        </AnimatePresence>
      </span>
      {level !== undefined && (
        <motion.span
          className="notch-bluetooth-battery"
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
        >
          <span className="notch-bluetooth-cell" aria-hidden="true">
            <span className="notch-bluetooth-cell-outline" />
            <motion.span
              className="notch-bluetooth-cell-fill"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: level / 100 }}
              transition={BATTERY_FILL}
            />
            <span className="notch-bluetooth-cell-nub" />
          </span>
          <span className="notch-bluetooth-percent">{level}%</span>
        </motion.span>
      )}
    </div>
  );
}
