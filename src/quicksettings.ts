/**
 * The small pieces of Quick Settings that are worth testing without a webview:
 * what the volume slider sends, and what the two rows say.
 *
 * Windows' mixer keeps a level *and* a mute flag, so they are separate facts:
 * a muted endpoint at 40% still has 40% waiting behind the mute. Showing that
 * level (instead of pinning the thumb at zero) is what lets the slider be
 * dragged up again.
 */

export type VolumeState = {
  /** 0.0 – 1.0, the scalar Core Audio stores. */
  level: number;
  muted: boolean;
};

const clampLevel = (level: number): number =>
  Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;

/** What a slider movement asks Windows to do. Reaching zero mutes the endpoint. */
export function volumeCommand(level: number): VolumeState {
  const clamped = clampLevel(level);
  return { level: clamped, muted: clamped <= 0 };
}

/** Where the thumb sits, as the 0–100 the slider speaks. */
export function volumePercent(level: number): number {
  return Math.round(clampLevel(level) * 100);
}

export function volumeLabel(level: number, muted: boolean): string {
  return muted ? "Mute" : `${volumePercent(level)}%`;
}

/** The panel has nothing honest to show when the display cannot report itself. */
export function brightnessLabel(value: number, supported: boolean): string {
  return supported ? `${Math.round(value)}%` : "—";
}
