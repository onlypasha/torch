import { emit } from "@tauri-apps/api/event";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const device = (kind, deviceId = "A", batteryPercent = null, detail = "AirPods Pro") =>
  emit("notch-activity", { kind, detail, bluetooth: { deviceId, batteryPercent } });

export async function runBluetoothScenario(scenario = "connected") {
  const rows = [], errors = [];
  const check = (ok, reason) => { if (!ok) errors.push(reason); };
  const start = performance.now();
  const state = () => {
    const n = document.querySelector("[data-notch]");
    const layer = [...document.querySelectorAll(".notch-bluetooth")].at(-1);
    const glyph = layer?.querySelector("svg");
    const fill = layer?.querySelector(".notch-bluetooth-cell-fill");
    const scale = (element) => element ? new DOMMatrix(getComputedStyle(element).transform).a : 0;
    return {
      t: performance.now() - start,
      kind: n.dataset.activity, phase: layer?.dataset.phase ?? "",
      name: layer?.querySelector(".notch-bluetooth-caption")?.textContent ?? "",
      battery: layer?.querySelector(".notch-bluetooth-percent")?.textContent ?? "",
      scale: scale(glyph), fill: scale(fill),
      path: glyph?.querySelector("path")?.getAttribute("stroke-dasharray"),
      radar: layer?.querySelectorAll(".notch-bluetooth-radar").length ?? 0,
      ripple: !!layer?.querySelector(".notch-bluetooth-ripple"),
      glow: Number(getComputedStyle(document.querySelector(".notch-glow")).opacity),
      width: parseFloat(getComputedStyle(n).width), height: parseFloat(getComputedStyle(n).height),
      open: n.getAttribute("aria-expanded") === "true", hidden: n.getAttribute("aria-hidden") === "true",
      clock: document.querySelector(".notch-clock")?.textContent ?? "",
    };
  };
  rows.push(state());
  const timer = setInterval(() => rows.push(state()), 25);
  try {
    if (scenario === "queued") {
      await device("bluetooth-connected", "A", 85, "Headset A");
      await device("bluetooth-connected", "B", 50, "DO NOT SHOW");
      await device("bluetooth-connected", "C", 0, "Mouse C");
      await wait(200);
      await device("bluetooth-disconnected", "B");
      await device("bluetooth-updated", "B", 90, "DO NOT SHOW");
      await wait(8700);
      check(!rows.some((s) => s.name === "DO NOT SHOW"), "cancel queued device");
      check(rows.some((s) => s.name === "Mouse C" && s.battery === "0%"), "keep unrelated device; zero is valid");
      const second = rows.find((s) => s.t > 4000 && s.phase === "connecting");
      check(second && second.width < 210 && second.glow === 0, "collapse fully between devices");
      check(!rows.some((s) => s.t > 500 && s.t < 8200 && s.clock), "no clock flash between devices");
    } else if (scenario === "cancel" || scenario === "full") {
      await device("bluetooth-connected", "A", 85);
      if (scenario === "full") {
        for (let i = 0; i < 7; i++) await device("bluetooth-connected", `queued-${i}`, null, "Queued");
      }
      await wait(500);
      await device("bluetooth-disconnected", "A");
      await device("bluetooth-updated", "A", 90);
      if (scenario === "full") {
        for (let i = 0; i < 7; i++) await device("bluetooth-disconnected", `queued-${i}`);
      }
      await wait(1100);
      check(!rows.some((s) => s.phase === "connected"), "cancel intro without success");
      check(!state().kind && !state().phase && state().width < 201, "silent cancellation collapses");
    } else if (scenario === "panel") {
      await emit("notch-press", null); await wait(400);
      await device("bluetooth-connected", "A", 85); await wait(1400);
      check(!state().phase && state().open, "do not interrupt panel");
      await emit("notch-click-outside", null); await wait(4600);
      check(rows.some((s) => s.name === "AirPods Pro"), "resume queued connection");
    } else {
      if (scenario === "autohide") {
        await emit("notch-autohide", true); await wait(450);
        check(state().hidden && state().height < 1, "start hidden");
      }
      const battery = ["unknown", "late"].includes(scenario) ? null : scenario === "zero" ? 0 : 85;
      await device("bluetooth-connected", "A", battery, scenario === "long" ? "Extremely long Bluetooth headset name with many characters" : "AirPods Pro");
      if (scenario === "late") {
        await wait(1900);
        await device("bluetooth-updated", "A", 85);
        await wait(2500);
      } else await wait(4500);
      const intro = rows.find((s) => s.phase === "connecting");
      const connected = rows.find((s) => s.phase === "connected");
      const end = rows.find((s) => s.t > (connected?.t ?? Infinity) && !s.kind);
      check(connected && Math.abs(connected.t - intro.t - 1300) < 130, "1300ms connecting intro");
      check(end && Math.abs(end.t - connected.t - 2600) < 140, "2600ms connected; battery must not restart timer");
      check(rows.filter((s) => s.phase === "connecting").every((s) => s.glow === 0 && !s.battery && !s.ripple), "no premature battery/glow/ripple");
      check(rows.some((s) => s.phase === "connecting" && s.radar === 2), "two radar rings");
      check(rows.some((s) => s.phase === "connected" && !s.radar && s.ripple && s.glow === 1), "radar stops, ripple/glow begin");
      // Sampling can miss the exact 1.25 keyframe on a busy/headless renderer.
      // Verify an observable bounce and that it returns to rest, not its peak.
      check(Math.max(...rows.map((s) => s.scale)) > 1.05 && rows.some((s) => s.phase === "connected" && s.t > connected.t + 600 && s.scale === 1), "icon pop and return to rest");
      check(rows.some((s) => s.path?.startsWith("1 ")), "symbol fully drawn");
      if (scenario === "unknown") check(!rows.some((s) => s.battery), "unknown battery hidden");
      else {
        const expected = scenario === "zero" ? 0 : 85;
        check(rows.some((s) => s.battery === `${expected}%` && Math.abs(s.fill - expected / 100) < 0.01), "real battery fill and percentage");
      }
      check(!state().kind && !state().phase && state().width < 201, "full collapse, no leftover indicator");
      if (scenario === "autohide") {
        check(state().hidden && state().height < 1, "return hidden");
        await emit("notch-autohide", false);
      }
    }
  } finally { clearInterval(timer); }
  const transitions = rows.filter((s, i) => !i || [s.kind, s.phase, s.open].join() !== [rows[i-1].kind, rows[i-1].phase, rows[i-1].open].join());
  window.__bluetoothProbe = { scenario, rows, errors, transitions };
  if (errors.length) throw new Error(errors.join("; "));
  return { scenario, errors, transitions, final: state() };
}
