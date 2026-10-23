import { AnimatePresence, motion } from "framer-motion";
import type { Transition } from "framer-motion";
import { usbCapacity } from "./usb";
import type { UsbState } from "./usb";

const DROP: Transition = { type: "spring", stiffness: 420, damping: 17, delay: 0.1 };
const POP: Transition = { type: "spring", stiffness: 520, damping: 18 };
const SWAP: Transition = { duration: 0.16 };
const RUNNER: Transition = { duration: 1, repeat: Infinity, ease: "easeInOut" };
const DRAW = (delay: number): Transition => ({ duration: 0.35, delay });

/** A real SVG trident: each stroke and terminal has its own arrival clock. */
function UsbIcon({ removed }: { removed: boolean }) {
  return (
    <motion.svg
      className="notch-usb-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      initial={removed ? { y: 0, opacity: 1 } : { y: -12, opacity: 0 }}
      animate={removed ? { y: [0, 2, -10], opacity: [1, 1, 0.45] } : { y: 0, opacity: 1 }}
      transition={removed ? { duration: 0.45, times: [0, 0.25, 1], ease: "easeOut" } : DROP}
    >
      <path d="m12 1 2.7 4.1H9.3Z" fill="currentColor" stroke="none" />
      {[
        { key: "stem", d: "M12 5v14", delay: 0.15 },
        { key: "left", d: "M12 15H9a3 3 0 0 1-3-3V9", delay: 0.3 },
        { key: "right", d: "M12 12h3a3 3 0 0 0 3-3V7", delay: 0.4 },
      ].map(({ key, d, delay }) => (
        <motion.path
          key={key}
          data-usb-stroke={key}
          d={d}
          initial={{ pathLength: removed ? 1 : 0 }}
          animate={{ pathLength: 1 }}
          transition={removed ? { duration: 0 } : DRAW(delay)}
        />
      ))}
      <motion.circle
        data-usb-pop="bottom"
        cx={12} cy={21} r={2}
        initial={{ scale: removed ? 1 : 0 }} animate={{ scale: 1 }}
        transition={removed ? { duration: 0 } : { ...POP, delay: 0.2 }}
      />
      <motion.circle
        data-usb-pop="left"
        cx={6} cy={7} r={2}
        initial={{ scale: removed ? 1 : 0 }} animate={{ scale: 1 }}
        transition={removed ? { duration: 0 } : { ...POP, delay: 0.5 }}
      />
      <motion.rect
        data-usb-pop="right"
        x={16} y={3} width={4} height={4} rx={0.2}
        initial={{ scale: removed ? 1 : 0 }} animate={{ scale: 1 }}
        transition={removed ? { duration: 0 } : { ...POP, delay: 0.58 }}
      />
    </motion.svg>
  );
}

/** Metadata changes the caption, not the icon: it must not draw itself twice. */
export function UsbContent({ usb, detail }: { usb: UsbState; detail: string }) {
  const removed = usb.phase === "removed";
  const ready = usb.phase === "ready";
  const caption = removed ? "Perangkat dilepas" : ready ? detail.trim() || "Perangkat USB" : "Membaca perangkat…";
  const capacity = ready ? usbCapacity(usb.capacityBytes) : "";

  return (
    <>
      <div className="notch-usb-row" data-removed={removed || undefined}>
        <span className="notch-usb-icon" aria-hidden="true">
          {ready && (
            <motion.span
              className="notch-usb-ring"
              initial={{ scale: 0.6, opacity: 0.6 }}
              animate={{ scale: 1.9, opacity: 0 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
          )}
          <UsbIcon removed={removed} />
        </span>
        <span className="notch-usb-title">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={usb.phase}
              className="notch-usb-caption"
              title={caption}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={SWAP}
            >
              {caption}
            </motion.span>
          </AnimatePresence>
        </span>
        {capacity && (
          <motion.span
            className="notch-usb-capacity"
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: 0.16 }}
          >
            {capacity}
          </motion.span>
        )}
      </div>
      <AnimatePresence>
        {usb.phase === "reading" && (
          <motion.div className="notch-usb-track" exit={{ opacity: 0, transition: { duration: 0.15 } }}>
            <motion.div
              className="notch-usb-runner"
              animate={{ x: ["-40%", "260%"] }}
              transition={RUNNER}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
