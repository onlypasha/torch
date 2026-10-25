/** WPF's three manual modes; no invented automatic session counter. */
export const POMODORO_MODES = [
  { id: "focus", label: "Fokus", seconds: 25 * 60 },
  { id: "short", label: "Istirahat singkat", seconds: 5 * 60 },
  { id: "long", label: "Istirahat panjang", seconds: 15 * 60 },
] as const;

export type PomodoroMode = (typeof POMODORO_MODES)[number];
export type PomodoroState = {
  mode: PomodoroMode;
  remaining: number;
  running: boolean;
  finished: boolean;
  deadline: number | null;
  feedbackUntil: number | null;
};
export type PomodoroAction =
  | { type: "tick"; now: number }
  | { type: "toggle"; now: number }
  | { type: "reset" }
  | { type: "next-mode" };

export function initialPomodoro(mode: PomodoroMode = POMODORO_MODES[0]): PomodoroState {
  return { mode, remaining: mode.seconds, running: false, finished: false, deadline: null, feedbackUntil: null };
}

function tick(state: PomodoroState, now: number): PomodoroState {
  if (!state.running || state.deadline === null) {
    return state.feedbackUntil !== null && now >= state.feedbackUntil
      ? { ...state, feedbackUntil: null }
      : state;
  }
  const remaining = Math.max(0, Math.ceil((state.deadline - now) / 1000));
  if (remaining === 0) {
    return { ...state, remaining: 0, running: false, finished: true, deadline: null, feedbackUntil: now + 3000 };
  }
  return remaining === state.remaining ? state : { ...state, remaining };
}

/** Wall-clock deadlines survive collapse, slow frames and sleep/resume. */
export function pomodoroReducer(state: PomodoroState, action: PomodoroAction): PomodoroState {
  if (action.type === "reset") return initialPomodoro(state.mode);
  if (action.type === "next-mode") {
    const next = (POMODORO_MODES.findIndex((mode) => mode.id === state.mode.id) + 1) % POMODORO_MODES.length;
    return initialPomodoro(POMODORO_MODES[next]);
  }
  if (action.type === "tick") return tick(state, action.now);
  if (state.running) {
    const current = tick(state, action.now);
    return current.finished ? current : { ...current, running: false, deadline: null };
  }
  const current = state.finished ? initialPomodoro(state.mode) : state;
  return { ...current, running: true, deadline: action.now + current.remaining * 1000, feedbackUntil: null };
}

export function pomodoroIndicator(state: PomodoroState): "finished" | "running" | "paused" | null {
  if (state.feedbackUntil !== null) return "finished";
  if (state.running) return "running";
  if (!state.finished && state.remaining < state.mode.seconds) return "paused";
  return null;
}
