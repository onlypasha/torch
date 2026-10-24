import { useEffect, useState } from "react";

/**
 * The card's accent, taken from the cover the way the WPF original did: the
 * average of the pixels that are not near-black, not near-white and not grey,
 * so a photograph does not wash the panel out to beige.
 *
 * Rendering happens on a 24px copy off-screen and is cached per data URL; the
 * cover only changes on a track change, so this runs a handful of times per
 * session rather than per frame.
 */
const cache = new Map<string, string | null>();
/** A data URL is large; keeping every cover of the session would leak memory. */
const CACHE_LIMIT = 16;

function remember(key: string, value: string | null): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function average(data: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 16) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    if (max < 40 || min > 215 || max - min < 24) continue;
    r += red;
    g += green;
    b += blue;
    count += 1;
  }
  if (count === 0) return null;
  return `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)})`;
}

export function useCoverAccent(url: string | undefined): string | null {
  const [accent, setAccent] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setAccent(null);
      return;
    }
    const cached = cache.get(url);
    if (cached !== undefined) {
      setAccent(cached);
      return;
    }
    let disposed = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no 2d context");
        context.drawImage(image, 0, 0, 24, 24);
        const value = average(context.getImageData(0, 0, 24, 24).data);
        remember(url, value);
        if (!disposed) setAccent(value);
      } catch {
        remember(url, null);
        if (!disposed) setAccent(null);
      }
    };
    image.onerror = () => {
      remember(url, null);
      if (!disposed) setAccent(null);
    };
    image.src = url;
    return () => {
      disposed = true;
    };
  }, [url]);

  return accent;
}
