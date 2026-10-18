import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Foundation prototype: an empty notch that opens, closes and settles cleanly.
 * No clock, no tabs, no widgets yet - those are layered on only once the
 * open/close motion is known to feel right.
 */

// Two states, two sizes. Every future tab will reuse EXPANDED so the geometry
// never changes between tabs; varying sizes can be revisited later.
const COLLAPSED = { width: 180, height: 32 };
const EXPANDED = { width: 400, height: 180 };

// Fixed canvas: the native window stays at EXPANDED and only the painted notch
// animates, so there is no native resize racing the animation. Flip this to
// false to instead grow/shrink the window around the animation (the window is
// grown to the union box *before* the notch animates and shrunk only after the
// closing animation settles).
const FIXED_CANVAS = true;

const MORPH = { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };

export default function App() {
  const [open, setOpen] = useState(false);
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while the native resize is in flight, which is what lets a fast
  // reverse cancel an in-progress open.
  const wanted = useRef(false);
  const resizeSeq = useRef(0);

  const setWindowSize = useCallback(async (width: number, height: number) => {
    const token = ++resizeSeq.current;
    try {
      await invoke("set_notch_size", { width, height });
    } catch (err) {
      console.error("set_notch_size failed:", err);
    }
    return token === resizeSeq.current;
  }, []);

  const openPanel = useCallback(async () => {
    wanted.current = true;
    if (!FIXED_CANVAS) {
      await setWindowSize(EXPANDED.width, EXPANDED.height);
      if (!wanted.current) return; // reversed while resizing
    }
    setOpen(true);
  }, [setWindowSize]);

  const closePanel = useCallback(() => {
    wanted.current = false;
    setOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (wanted.current) closePanel();
    else void openPanel();
  }, [closePanel, openPanel]);

  const handleSettled = useCallback(() => {
    if (FIXED_CANVAS) return;
    if (!wanted.current) void setWindowSize(COLLAPSED.width, COLLAPSED.height);
  }, [setWindowSize]);

  // Outside clicks come from the native low-level mouse hook: the window is
  // WS_EX_NOACTIVATE and only notch-sized, so it never sees those clicks itself.
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

  // Keep the native click-outside hook aware of whether the panel is open.
  useEffect(() => {
    void invoke("set_panel_open", { open }).catch(() => {});
  }, [open]);

  // Debug probe: a click that reaches the webview outside the painted notch
  // means the transparent canvas is swallowing desktop clicks. The title is
  // readable from Win32, so it doubles as the assertion channel.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.dataset.notch) return;
      document.title = `hit ${Math.round(event.clientX)},${Math.round(event.clientY)}`;
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  return (
    <div className="h-full w-full select-none bg-transparent">
      <motion.div
        data-notch="1"
        role="button"
        tabIndex={0}
        aria-label="Notch"
        aria-expanded={open}
        initial={false}
        animate={{
          width: open ? EXPANDED.width : COLLAPSED.width,
          height: open ? EXPANDED.height : COLLAPSED.height,
        }}
        transition={MORPH}
        onAnimationComplete={handleSettled}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle();
        }}
        className="absolute top-0 left-1/2 -translate-x-1/2 rounded-b-[22px] bg-[#1c1c1c] shadow-[0_8px_24px_rgba(0,0,0,0.45)] outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      />
    </div>
  );
}
