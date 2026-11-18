import { useEffect, useState } from "react";
import { StringCache } from "./stringCache";

/**
 * The card's accent, taken from the cover the way the WPF original did: the
 * average of the pixels that are not near-black, not near-white and not grey,
 * so a photograph does not wash the panel out to beige.
 *
 * Rendering happens on a 24px copy off-screen and is cached per data URL; the
 * cover only changes on a track change, so this runs a handful of times per
 * session rather than per frame.
 */
const cache = new StringCache(16, 2 * 1024 * 1024);

function remember(key: string, value: string | null): void {
  cache.set(key, value);
}

function extractDominant(data: Uint8ClampedArray): string | null {
  // Bucket colorful pixels by hue and saturation
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;
  let fallbackCount = 0;

  for (let i = 0; i < data.length; i += 16) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;

    // Skip extreme darks, lights or purely neutral grays
    if (max < 32 || min > 225) continue;

    fallbackR += red;
    fallbackG += green;
    fallbackB += blue;
    fallbackCount += 1;

    if (delta < 20) continue;

    // Simple 12-bin hue quantization
    let hue = 0;
    if (delta > 0) {
      if (max === red) {
        hue = ((green - blue) / delta) % 6;
      } else if (max === green) {
        hue = (blue - red) / delta + 2;
      } else {
        hue = (red - green) / delta + 4;
      }
      hue = Math.round(hue * 60);
      if (hue < 0) hue += 360;
    }
    const bin = Math.floor(hue / 30);
    const bucket = buckets.get(bin) ?? { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += red;
    bucket.g += green;
    bucket.b += blue;
    bucket.count += 1;
    buckets.set(bin, bucket);
  }

  // Find bucket with highest pixel count
  let best: { r: number; g: number; b: number; count: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) {
      best = bucket;
    }
  }

  if (best && best.count > 0) {
    return `rgb(${Math.round(best.r / best.count)} ${Math.round(best.g / best.count)} ${Math.round(best.b / best.count)})`;
  }
  if (fallbackCount > 0) {
    return `rgb(${Math.round(fallbackR / fallbackCount)} ${Math.round(fallbackG / fallbackCount)} ${Math.round(fallbackB / fallbackCount)})`;
  }
  return null;
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
        const value = extractDominant(context.getImageData(0, 0, 24, 24).data);
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
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    };
  }, [url]);

  return accent;
}
