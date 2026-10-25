import { expect, test } from "bun:test";
import { initialPomodoro, POMODORO_MODES, pomodoroIndicator, pomodoroReducer } from "../src/pomodoro";

test("WPF modes cycle 25/5/15 minutes and stop/reset the current session", () => {
  let state = initialPomodoro();
  expect(POMODORO_MODES.map((mode) => mode.seconds)).toEqual([1500, 300, 900]);
  for (const [mode, remaining] of [["short", 300], ["long", 900], ["focus", 1500]] as const) {
    state = pomodoroReducer(state, { type: "toggle", now: 0 });
    state = pomodoroReducer(state, { type: "next-mode" });
    expect(state.mode.id).toBe(mode);
    expect(state.remaining).toBe(remaining);
    expect(state.running).toBe(false);
    expect(state.deadline).toBeNull();
    expect(pomodoroIndicator(state)).toBeNull();
  }
});

test("a running deadline catches up after a closed panel or long sleep", () => {
  let state = pomodoroReducer(initialPomodoro(), { type: "toggle", now: 1000 });
  state = pomodoroReducer(state, { type: "tick", now: 61_000 });
  expect(state.remaining).toBe(1440);
  expect(pomodoroIndicator(state)).toBe("running");
  state = pomodoroReducer(state, { type: "tick", now: 4_000_000 });
  expect(state.remaining).toBe(0);
  expect(state.finished).toBe(true);
  expect(state.running).toBe(false);
  expect(pomodoroIndicator(state)).toBe("finished");
});

test("pause freezes time, resume uses only remaining time, reset keeps the chosen mode", () => {
  let state = pomodoroReducer(initialPomodoro(POMODORO_MODES[1]), { type: "toggle", now: 0 });
  state = pomodoroReducer(state, { type: "toggle", now: 10_000 });
  expect(state.remaining).toBe(290);
  expect(pomodoroIndicator(state)).toBe("paused");
  expect(pomodoroReducer(state, { type: "tick", now: 99_000 })).toBe(state);
  state = pomodoroReducer(state, { type: "toggle", now: 100_000 });
  expect(state.deadline).toBe(390_000);
  state = pomodoroReducer(state, { type: "reset" });
  expect(state).toEqual(initialPomodoro(POMODORO_MODES[1]));
});

test("completion feedback lasts three seconds and is not retriggered by later ticks", () => {
  let state = pomodoroReducer(initialPomodoro(POMODORO_MODES[1]), { type: "toggle", now: 0 });
  state = pomodoroReducer(state, { type: "tick", now: 300_000 });
  expect(pomodoroIndicator(state)).toBe("finished");
  state = pomodoroReducer(state, { type: "tick", now: 302_999 });
  expect(pomodoroIndicator(state)).toBe("finished");
  state = pomodoroReducer(state, { type: "tick", now: 303_000 });
  expect(pomodoroIndicator(state)).toBeNull();
  expect(pomodoroReducer(state, { type: "tick", now: 999_000 })).toBe(state);
  state = pomodoroReducer(state, { type: "toggle", now: 999_000 });
  expect(state.remaining).toBe(300);
  expect(state.deadline).toBe(1_299_000);
  expect(state.finished).toBe(false);
});

test("pausing an overdue timer finishes it instead of reviving it at zero", () => {
  const running = pomodoroReducer(initialPomodoro(POMODORO_MODES[1]), { type: "toggle", now: 0 });
  const finished = pomodoroReducer(running, { type: "toggle", now: 301_000 });
  expect(finished.finished).toBe(true);
  expect(pomodoroIndicator(finished)).toBe("finished");
  expect(pomodoroIndicator(pomodoroReducer(finished, { type: "reset" }))).toBeNull();
  expect(pomodoroIndicator(pomodoroReducer(finished, { type: "next-mode" }))).toBeNull();
});
