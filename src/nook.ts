/**
 * The Nook's widget rules, kept free of React so the stack rotation, the pin
 * limits, the calendar week and the compact views can be tested without a
 * browser. The components in `Nook.tsx` only render what these return.
 */

export const WIDGETS = ["calendar", "pomodoro", "lyric", "weather"] as const;
export type WidgetId = (typeof WIDGETS)[number];

export const WIDGET_LABEL: Record<WidgetId, string> = {
  calendar: "Kalender",
  pomodoro: "Pomodoro",
  lyric: "Lirik",
  weather: "Cuaca",
};

/** Two pinned at most, and the stack always keeps at least one widget. */
export const MAX_PINNED = 2;

/** The stack, in its fixed order, without the widgets that live in the column. */
export const stackWidgets = (pinned: readonly WidgetId[]): WidgetId[] =>
  WIDGETS.filter((widget) => !pinned.includes(widget));

/** Next/previous in the endless rotation; `delta` is +1 or -1. */
export function rotate(list: readonly WidgetId[], active: WidgetId, delta: 1 | -1): WidgetId {
  const at = list.indexOf(active);
  if (at < 0) return list[0];
  return list[(at + delta + list.length) % list.length];
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
export type PinVerdict = "pin" | "unpin" | "full" | "last-in-stack";

export function pinVerdict(pinned: readonly WidgetId[], widget: WidgetId): PinVerdict {
  if (pinned.includes(widget)) return "unpin";
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
export const POMODORO_SESSION = "1/4";

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
export const pomodoroFraction = (remainingSeconds: number): number =>
  Math.max(0, Math.min(1, remainingSeconds / POMODORO_SECONDS));

// ---------------------------------------------------------------------------
// Weather (sample data, as the spec's preview)
// ---------------------------------------------------------------------------

export const WEATHER = {
  temperature: 27,
  condition: "Cerah berawan",
  hourly: [
    { label: "Kini", temperature: 27 },
    { label: "14.00", temperature: 28 },
    { label: "16.00", temperature: 27 },
    { label: "18.00", temperature: 25 },
  ],
} as const;
