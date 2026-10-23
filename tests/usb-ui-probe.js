import { emit } from "@tauri-apps/api/event";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const device = (kind, id, detail = "USB DISK 2.0", capacityBytes = null) =>
  emit("notch-activity", { kind, detail, usb: { deviceId: id, capacityBytes } });

/** Run on usb-ui.html, which uses Tauri's event mocks, not the desktop hook. */
export async function runUsbScenario(scenario = "ready") {
  const rows = [];
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const start = performance.now();
  const sample = () => {
    const notch = document.querySelector("[data-notch]");
    // The outgoing layer remains mounted for 120ms. The last is the current one.
    const layer = [...document.querySelectorAll(".notch-usb")].at(-1);
    const css = getComputedStyle(notch);
    return {
      t: performance.now() - start,
      activity: notch.dataset.activity,
      phase: layer?.dataset.phase ?? "",
      caption: layer?.querySelector(".notch-usb-caption")?.textContent ?? "",
      capacity: layer?.querySelector(".notch-usb-capacity")?.textContent ?? "",
      width: parseFloat(css.width), height: parseFloat(css.height),
      glow: Number(getComputedStyle(document.querySelector(".notch-glow")).opacity),
      open: notch.getAttribute("aria-expanded") === "true",
      hidden: notch.getAttribute("aria-hidden") === "true",
      clock: document.querySelector(".notch-clock")?.textContent ?? "",
    };
  };
  rows.push(sample());
  const timer = setInterval(() => rows.push(sample()), 25);
  try {
    if (scenario === "network") {
      await emit("notch-activity", { kind: "wifi-connected", detail: "Home Wi-Fi" });
      await wait(150);
      await device("usb-connected", "N");
      await device("usb-ready", "N", "USB DISK 2.0", 32e9);
      await wait(8500);
      const first = rows.find((s) => s.phase);
      check(first?.phase === "reading" && first.t >= 4500, "wait for network's full collapse");
      check(rows.some((s) => s.caption === "USB DISK 2.0"), "USB follows network");
      check(!sample().activity && !sample().phase, "both indicators complete");
    } else if (scenario === "queued") {
      await emit("notch-activity", { kind: "power-connected", detail: "79%" });
      await wait(150);
      await device("usb-connected", "A");
      await device("usb-ready", "A", "Stick A", 32e9);
      await device("usb-connected", "B", "Keyboard");
      await device("usb-ready", "B", "Keyboard");
      await device("usb-disconnected", "A");
      await wait(10300);
      const first = rows.find((s) => s.phase);
      check(first?.phase === "removed" && first.t >= 3900, "wait for charger's full collapse");
      check(!rows.some((s) => s.caption === "Stick A"), "cancel stale queued arrival");
      check(rows.some((s) => s.caption === "Keyboard"), "retain other devices");
      check(rows.filter((s) => s.phase === "reading").every((s) => s.glow === 0), "no inherited glow");
    } else if (scenario === "panel") {
      await emit("notch-press", null);
      await wait(500);
      await device("usb-connected", "P");
      await device("usb-ready", "P", "Keyboard");
      await wait(1000);
      check(!sample().phase && sample().open, "do not interrupt panel");
      await emit("notch-click-outside", null);
      await wait(4400);
      check(rows.some((s) => s.caption === "Keyboard"), "resume after panel closes");
    } else if (scenario === "full") {
      await device("usb-connected", "F");
      for (let i = 0; i < 7; i++) await emit("notch-activity", {
        kind: "bluetooth-connected", detail: `Queued ${i}`, bluetooth: { deviceId: `queued-${i}` },
      });
      await device("usb-ready", "F", "Full queue", 32e9);
      await wait(1000);
      check(sample().phase === "ready", "accept metadata with full queue");
      await device("usb-disconnected", "F");
      await wait(350);
      check(sample().phase === "removed", "accept cancellation with full queue");
      await device("usb-ready", "F", "STALE", 32e9);
      await wait(1900);
      check(!sample().phase, "ignore stale metadata after removal");
    } else {
      if (scenario === "autohide") {
        await emit("notch-autohide", true);
        await wait(450);
        check(sample().height < 1 && sample().hidden, "start hidden");
      }
      await device("usb-connected", "T", scenario === "timeout" ? "" : "USB DISK 2.0");
      if (scenario === "remove") {
        await wait(300);
        await device("usb-disconnected", "T");
        await device("usb-ready", "T", "STALE", 32e9);
        await wait(2400);
        const removed = rows.find((s) => s.phase === "removed");
        const end = rows.find((s) => s.t > (removed?.t ?? Infinity) && !s.activity);
        check(removed && end && Math.abs(end.t - removed.t - 1800) < 120, "removal dwell 1800ms");
        check(!rows.some((s) => s.phase === "ready"), "never show stale success");
        check(rows.filter((s) => s.phase === "removed").every((s) => !s.capacity && s.glow === 0), "removal has no capacity/glow");
      } else {
        if (scenario !== "timeout") {
          await wait(scenario === "late" ? 1800 : 200);
          await device("usb-ready", "T", scenario === "long" ? "Very long USB storage device name with many characters" : scenario === "nostorage" ? "Wireless Keyboard" : "USB DISK 2.0", scenario === "nostorage" ? null : 32e9);
        }
        await wait(scenario === "timeout" ? 15700 : 4200);
        const reading = rows.find((s) => s.phase === "reading");
        const ready = rows.find((s) => s.phase === "ready");
        const end = rows.find((s) => s.t > (ready?.t ?? Infinity) && !s.activity);
        const expected = scenario === "timeout" ? 12000 : scenario === "late" ? 1800 : 800;
        check(ready && Math.abs(ready.t - reading.t - expected) < 180, "reading minimum / Windows reply / timeout");
        check(end && Math.abs(end.t - ready.t - 2600) < 140, "ready dwell 2600ms");
        check(rows.filter((s) => s.phase === "reading").every((s) => s.glow === 0), "no reading glow");
        check(rows.some((s) => s.phase === "ready" && s.glow === 1), "glow after ready");
        if (scenario === "timeout") check(rows.some((s) => s.caption === "Perangkat USB" && !s.capacity), "fallback without invented metadata");
        else if (scenario === "nostorage") check(!rows.some((s) => s.capacity), "no capacity for non-storage");
        else check(rows.some((s) => s.capacity === "32 GB"), "capacity from payload");
      }
      check(!sample().activity && !sample().phase && sample().width < 201, "full collapse, no leftover indicator");
      if (scenario === "autohide") {
        check(sample().hidden && sample().height < 1, "return hidden");
        await emit("notch-autohide", false);
      }
    }
  } finally {
    clearInterval(timer);
  }
  const transitions = rows.filter((s, i) => i === 0 ||
    [s.activity, s.phase, s.open].join() !== [rows[i - 1].activity, rows[i - 1].phase, rows[i - 1].open].join());
  window.__usbProbe = { scenario, errors, transitions, rows };
  if (errors.length) throw new Error(errors.join("; "));
  return { scenario, errors, transitions, final: sample() };
}
