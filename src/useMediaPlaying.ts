import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MediaState } from "./media";

/**
 * Just enough of the media state for the collapsed notch: whether something is
 * playing. The full state (and its artwork) belongs to the open panel, but the
 * closed bar still has to say "music is playing" without mounting that panel.
 */
export function useMediaPlaying(): boolean {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<MediaState>("media-state", (event) => {
      setPlaying(event.payload?.playing === true);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  return playing;
}
