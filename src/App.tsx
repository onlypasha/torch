import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Foundation prototype: an empty notch that opens, closes and settles cleanly.
 * No clock, no tabs, no widgets yet - those are layered on only once the
 * open/close motion is known to feel right.
 *
 * Two states, two sizes. Every future tab will reuse EXPANDED so the geometry
 * never changes between tabs; varying sizes can be revisited later.
 */
const COLLAPSED = { width: 180, height: 32 };
const EXPANDED = { width: 400, height: 180 };

/** Must match the bottom corner radius used by the notch class below. */
const CORNER = 22;
/** Extra hit area under the notch so the drop shadow keeps its room. */
const SHADOW_MARGIN = 20;

const MORPH = { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const };

export default function App() {
  const [open, setOpen] = useState(false);
  // `wanted` is the user's intent; `open` is the rendered state. They differ
  // only while a native call is in flight, which is what lets a fast reverse
  // cancel an open that has not started animating yet.
  const wanted = useRef(false);

  /**
   * The native window always keeps the expanded size, so it never has to be
   * resized mid-animation (a resize makes WebView2 re-create its surface and the
   * notch blinks). Instead the *hit region* shrinks to the notch silhouette
   * while collapsed, which is also what makes the surrounding area click-through.
   */
  const setHitRegion = useCallback(
    async (which: "notch" | "full") => {
      const size = which === "notch" ? COLLAPSED : { width: 0, height: 0 };
      try {
        await invoke("set_hit_region", {
          width: size.width,
          height: size.height,
          radius: which === "notch" ? CORNER : 0,
          margin: which === "notch" ? SHADOW_MARGIN : 0,
        });
      } catch (err) {
        console.error("set_hit_region failed:", err);
      }
    },
    [],
  );

  const openPanel = useCallback(async () => {
    wanted.current = true;
    // Unclip before the notch starts growing, otherwise the region would crop
    // the expanding panel.
    await setHitRegion("full");
    if (!wanted.current) return; // reversed while the call was in flight
    setOpen(true);
  }, [setHitRegion]);

  const closePanel = useCallback(() => {
    wanted.current = false;
    setOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (wanted.current) closePanel();
    else void openPanel();
  }, [closePanel, openPanel]);

  const handleSettled = useCallback(() => {
    // Only once the closing animation is done is the notch small enough to
    // shrink the hit region; doing it earlier would crop the animation.
    if (!wanted.current) void setHitRegion("notch");
  }, [setHitRegion]);

  // Re-assert the collapsed hit area as soon as the webview is alive.
  useEffect(() => {
    void setHitRegion("notch");
  }, [setHitRegion]);

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

  // Keep the native click-outside hook aware of whether the panel is open.
  useEffect(() => {
    void invoke("set_panel_open", { open }).catch(() => {});
  }, [open]);

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
