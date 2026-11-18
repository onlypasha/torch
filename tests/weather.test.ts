import { expect, test } from "bun:test";
import { createWeatherLoader, parseWeather, weatherCondition, weatherTime } from "../src/weather";

const now = Date.UTC(2026, 10, 15, 18, 30);
const payload = (at = now) => ({ timezone: "Asia/Jakarta", current: { time: at / 1000, temperature_2m: 26.6, weather_code: 61, is_day: 0 }, hourly: { time: [at / 1000 - 1800, at / 1000 + 1800, at / 1000 + 5400, at / 1000 + 9000, at / 1000 + 12600, at / 1000 + 16200], temperature_2m: [25, 26, null, 24, 23, 22] } });
const location = { name: "Kota uji", latitude: -6.2, longitude: 106.8 };
test("weather preserves real zero and negative temperatures; rejects missing current measurements", () => {
  for (const value of [0, -15]) { const data = payload(); data.current.temperature_2m = value; expect(parseWeather(data, now).temperature).toBe(value); }
  for (const value of [null, undefined, NaN, Infinity, 99]) {
    const data = payload(); (data.current as Record<string, unknown>).temperature_2m = value;
    expect(() => parseWeather(data, now)).toThrow();
  }
  expect(() => parseWeather(null, now)).toThrow();
});
test("forecast skips past and missing temperatures and uses the location timezone across midnight", () => {
  const result = parseWeather(payload(), now);
  expect(result.temperature).toBe(27);
  expect(result.condition).toBe("Hujan ringan");
  expect(result.hourly.map(hour => hour.label)).toEqual(["02.00", "04.00", "05.00", "06.00"]);
  expect(result.hourly.map(hour => hour.temperature)).toEqual([26, 24, 23, 22]);
  expect(weatherTime(now, "America/New_York")).toBe("13.30");
});
test("weather age remains provider time; invalid timezone and future measurements fail", () => {
  const old = payload(now - 3_600_000);
  expect(parseWeather(old, now).currentAt).toBe(now - 3_600_000);
  expect(() => parseWeather(payload(now + 3_600_000), now)).toThrow();
  expect(() => parseWeather({ ...payload(), timezone: "not-a-zone" }, now)).toThrow();
  expect(weatherCondition(0, false)).toBe("Malam cerah");
  expect(weatherCondition(999, true)).toBe("Kondisi tidak diketahui");
  expect(weatherCondition(99, true)).toContain("hujan es");
});
test("one shared request supplies stack and pin; cached reads do not refetch; retry keeps failures uncached", async () => {
  let calls = 0;
  let fail = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = createWeatherLoader(async () => { calls++; await gate; if (fail) throw new Error("offline"); return payload(Date.now()); });
  const a = load(location, true), b = load(location, true);
  expect(a).toBe(b); expect(calls).toBe(1); release();
  const data = await a;
  expect(await load(location, true)).toBe(data); expect(calls).toBe(1);
  fail = true;
  await expect(load(location, true, true)).rejects.toThrow("offline");
  fail = false;
  await load(location, false); expect(calls).toBe(3);
  await load({ ...location, latitude: 10 }, false); expect(calls).toBe(4);
});
