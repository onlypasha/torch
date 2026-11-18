/**
 * The Nook's widget rules, kept free of React so the stack rotation, the pin
 * limits, the calendar week and the compact views can be tested without a
 * browser. The components in `Nook.tsx` only render what these return.
 */

export const WIDGETS = [
  "quicksettings",
  "sysmon",
  "calendar",
  "pomodoro",
  "lyric",
  "weather",
] as const;
export type WidgetId = (typeof WIDGETS)[number];

export const WIDGET_LABEL: Record<WidgetId, string> = {
  quicksettings: "Quick Settings",
  sysmon: "Monitor Sistem",
  calendar: "Kalender",
  pomodoro: "Pomodoro",
  lyric: "Lirik",
  weather: "Cuaca",
};

export const PINNABLE_WIDGETS: readonly WidgetId[] = [
  "calendar",
  "pomodoro",
  "weather",
];

export const isPinnable = (widget: WidgetId): boolean =>
  PINNABLE_WIDGETS.includes(widget);

/** Two pinned at most, and the stack always keeps at least one widget. */
export const MAX_PINNED = 2;

/** Match the visible Nook columns, retaining room for the tab bar when empty. */
export function nookPanelWidth(media: boolean, widgets: number, pinned: number): number {
  const columns = [media ? 352 : 0, widgets > 0 ? 252 : 0, pinned > 0 ? 100 : 0].filter(Boolean);
  return Math.max(276, 24 + columns.reduce((sum, width) => sum + width, 0) + Math.max(0, columns.length - 1) * 12);
}

/** The stack, in its fixed order, without the widgets that live in the column. */
export const stackWidgets = (pinned: readonly WidgetId[]): WidgetId[] =>
  WIDGETS.filter((widget) => !pinned.includes(widget));

/** Next/previous in the endless rotation; `delta` is +1 or -1. */
export function rotate(list: readonly WidgetId[], active: WidgetId, delta: 1 | -1): WidgetId {
  const at = list.indexOf(active);
  if (at < 0) return list[0];
  return list[(at + delta + list.length) % list.length];
}

/** WheelEvent has no gesture phase: infer a fresh push, not every momentum tick. */
export class WidgetWheelNavigator {
  private lastEvent = Number.NEGATIVE_INFINITY;
  private lastStep = Number.NEGATIVE_INFINITY;
  private direction = 0;
  private previous = 0;
  private peak = 0;
  private low = Number.POSITIVE_INFINITY;
  private rises = 0;

  step(deltaY: number, deltaX: number, now: number, deltaMode = 0): 1 | -1 | 0 {
    if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) return 0;
    const magnitude = Math.abs(deltaY);
    const direction = deltaY > 0 ? 1 : -1;
    const quiet = now - this.lastEvent > 180;
    this.lastEvent = now;

    const accept = () => {
      this.lastStep = now;
      this.direction = direction;
      this.previous = this.peak = magnitude;
      this.low = Number.POSITIVE_INFINITY;
      this.rises = 0;
      return direction as 1 | -1;
    };
    // Line/page events are discrete wheel input, not pixel-based touchpad
    // momentum. Keep WPF's throttle for that input source.
    if (deltaMode !== 0) return now - this.lastStep >= 350 ? accept() : 0;
    if (quiet) return accept();

    const canStep = now - this.lastStep >= 160;
    if (direction !== this.direction) {
      // Ignore tiny direction bounces at the end of a swipe. A deliberate
      // opposite push responds without waiting for the old tail to end.
      if (canStep && magnitude >= Math.max(6, this.previous * 1.5)) return accept();
      this.rises = 0;
      return 0;
    }
    this.peak = Math.max(this.peak, magnitude);
    if (magnitude <= this.peak * 0.6) this.low = Math.min(this.low, magnitude);
    // Two substantial rises after decay distinguish another finger push from
    // an isolated noisy tail sample. No high fixed activation threshold.
    const rising = magnitude >= Math.max(4, this.low * 1.6)
      && magnitude - this.previous >= Math.max(1.5, this.previous * 0.25);
    this.rises = rising ? this.rises + 1 : 0;
    this.previous = magnitude;
    if (canStep && this.rises >= 2) return accept();
    return 0;
  }
}

/**
 * How far a card is from the active one: 0 is active, 1 the card queued behind
 * it, and `length - 1` is the one that has just left and waits above the stack.
 */
export const stackOffset = (list: readonly WidgetId[], active: WidgetId, widget: WidgetId): number => {
  const length = list.length;
  const at = list.indexOf(widget);
  const current = list.indexOf(active);
  if (at < 0 || current < 0) return 0;
  return (at - current + length) % length;
};

export const STACK_POSITION = {
  active: { y: 0, scale: 1, opacity: 1 },
  next: { y: 12, scale: 0.95, opacity: 0.55 },
  further: { y: 22, scale: 0.9, opacity: 0.28 },
  previous: { y: -26, scale: 1, opacity: 0 },
} as const;

export type StackSlot = keyof typeof STACK_POSITION;

/** Which of the four resting places a card occupies. */
export function stackSlot(offset: number, length: number): StackSlot {
  if (offset === 0) return "active";
  if (offset === 1) return "next";
  if (offset === length - 1) return "previous";
  return "further";
}

/** Why a widget cannot be pinned, or that it can. */
export type PinVerdict = "pin" | "unpin" | "full" | "last-in-stack" | "not-pinnable";

export function pinVerdict(pinned: readonly WidgetId[], widget: WidgetId): PinVerdict {
  if (pinned.includes(widget)) return "unpin";
  if (!isPinnable(widget)) return "not-pinnable";
  if (pinned.length >= MAX_PINNED) return "full";
  if (stackWidgets(pinned).length <= 1) return "last-in-stack";
  return "pin";
}

/** Pinning appends at the bottom of the column; duplicates are impossible. */
export function pinWidget(pinned: readonly WidgetId[], widget: WidgetId): WidgetId[] {
  return pinVerdict(pinned, widget) === "pin" ? [...pinned, widget] : [...pinned];
}

export function unpinWidget(pinned: readonly WidgetId[], widget: WidgetId): WidgetId[] {
  return pinned.filter((id) => id !== widget);
}

/** Swaps two neighbours after a vertical drag; no-op for equal or bad indices. */
export function swapPinned(pinned: readonly WidgetId[], from: number, to: number): WidgetId[] {
  if (from === to || from < 0 || to < 0 || from >= pinned.length || to >= pinned.length) {
    return [...pinned];
  }
  const next = [...pinned];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const DAY_SHORT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"] as const;

export const MONTH_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
] as const;

export const MONTH_SHORT_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
] as const;

export const WEEKDAY_ID = [
  "Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu",
] as const;

export type WeekDay = { date: Date; weekday: string; day: number; today: boolean; key: string };

/** Monday-first week containing `date`, which is what the strip shows. */
export function weekOf(date: Date): WeekDay[] {
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const sinceMonday = (midnight.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(midnight);
    day.setDate(midnight.getDate() + index - sinceMonday);
    return {
      date: day,
      weekday: DAY_SHORT[index],
      day: day.getDate(),
      today: day.getTime() === midnight.getTime(),
      key: `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`,
    };
  });
}

export const calendarTitle = (date: Date): string =>
  `${MONTH_ID[date.getMonth()]} ${date.getFullYear()}`;

export const compactMonth = (date: Date): string => MONTH_SHORT_ID[date.getMonth()];

export const weekdayLong = (date: Date): string => WEEKDAY_ID[date.getDay()];

// ---------------------------------------------------------------------------
// Pomodoro
// ---------------------------------------------------------------------------
//
// Timed lyrics live in `lyrics.ts`: they are fetched from LRCLIB rather than
// invented, so they belong with the fetching and parsing, not with the pure
// widget rules here.

export const POMODORO_SECONDS = 25 * 60;

export type PomodoroPhase = "running" | "paused" | "finished";

export const pomodoroPhase = (running: boolean, finished: boolean): PomodoroPhase =>
  finished ? "finished" : running ? "running" : "paused";

export const POMODORO_STATUS: Record<PomodoroPhase, string> = {
  running: "Fokus",
  paused: "Jeda",
  finished: "Selesai",
};

export const pomodoroClock = (remainingSeconds: number): string => {
  const safe = Math.max(0, Math.ceil(remainingSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};

/** Remaining fraction for both rings/borders; 1 at 25:00, 0 when finished. */
export const pomodoroFraction = (remainingSeconds: number, durationSeconds = POMODORO_SECONDS): number =>
  durationSeconds > 0 ? Math.max(0, Math.min(1, remainingSeconds / durationSeconds)) : 0;

