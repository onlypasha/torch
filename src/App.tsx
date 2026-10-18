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
   * notch blinks). Collapsed therefore means "click-through": while the notch is
   * small the whole window ignores the mouse, and a low-level hook is what
   * notices - and swallows - a click on the notch itself.
   */
  const setHitArea = useCallback(
    async (which: "notch" | "full") => {
      try {
        await invoke("set_notch_hit", {
          width: which === "notch" ? COLLAPSED.width : 0,
          height: which === "notch" ? COLLAPSED.height : 0,
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
    await setHitArea("full");
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
    // Only once the closing animation is done is the notch small enough to
    // shrink the hit area; doing it earlier would make the shrinking panel
    // click-through mid-flight.
    if (!wanted.current) void setHitArea("notch");
  }, [setHitArea]);

  // Re-assert the collapsed hit area as soon as the webview is alive.
  useEffect(() => {
    void setHitArea("notch");
  }, [setHitArea]);

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
        className="absolute top-0 left-1/2 -translate-x-1/2 rounded-b-[22px] bg-[#1c1c1c] outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      />
    </div>
  );
}
