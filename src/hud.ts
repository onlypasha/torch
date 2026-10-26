/**
 * The HUD's small, testable facts.
 *
 * Volume is shown at the window's 0-100 scale, but its step is the notch's own
 * 6.25% grid (1.5625% with Shift). Windows' scalar is still the authority:
 * `hud.ts` only formats what it reports; `keyboard.rs` owns the step and reads
 * the endpoint back, and the webview draws what came back.
 */

export const HUD_HOLD_MS = 1600;

const clamp = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** The percentage the HUD bar and number show. Mute empties both. */
export function hudPercent(kind: "volume" | "brightness", level: number, muted: boolean): number {
  if (kind === "volume") {
    if (muted) return 0;
    return Math.round(clamp(level) * 100);
  }
  return Math.round(Number.isFinite(level) ? Math.min(100, Math.max(0, level)) : 0);
}

/** What the screen reader says. Mute is a state, not a level of zero. */
export function hudAnnouncement(
  kind: "volume" | "brightness",
  level: number,
  muted: boolean,
): string {
  if (kind === "brightness") {
    return `Kecerahan ${hudPercent("brightness", level, false)}%`;
  }
  if (muted) return "Volume dimatikan";
  return `Volume ${hudPercent("volume", level, false)}%`;
}

/** Three speaker waves, each one earned by another third of the range. */
export function volumeWaves(level: number, muted: boolean): number {
  if (muted) return 0;
  const value = clamp(level);
  if (value > 0.67) return 3;
  if (value > 0.34) return 2;
  if (value > 0) return 1;
  return 0;
}
