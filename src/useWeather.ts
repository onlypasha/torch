import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runtimeConfig } from "./config";
import { createWeatherLoader, WEATHER_REFRESH_MS, WEATHER_STALE_MS } from "./weather";
import type { WeatherReading } from "./weather";

const load = createWeatherLoader((location, followWindows) => invoke("weather_get", { location, followWindows }));
export function useWeather() {
  const enabled = runtimeConfig.widgets.includes("weather");
  const location = runtimeConfig.weatherLocation ?? null;
  const followWindows = runtimeConfig.weatherFollowWindows ?? true;
  const [data, setData] = useState<WeatherReading | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const lastAttempt = useRef(0);
  const active = useRef(false);
  const pending = useRef(false);
  const refresh = useCallback(async (force = false) => {
    if (!enabled || !location || pending.current) return;
    pending.current = true;
    lastAttempt.current = Date.now();
    setBusy(true);
    try {
      const reading = await load(location, followWindows, force);
      if (active.current) { setData(reading); setError(""); }
    } catch (reason) {
      if (active.current) setError(String(reason).replace(/^Error: /, ""));
    } finally {
      pending.current = false;
      if (active.current) { setBusy(false); setNow(Date.now()); }
    }
  }, [enabled, location, followWindows]);
  useEffect(() => {
    active.current = true;
    if (!enabled || !location) return () => { active.current = false; };
    void refresh();
    const tick = () => {
      setNow(Date.now());
      if (Date.now() - lastAttempt.current >= WEATHER_REFRESH_MS) void refresh();
    };
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    window.addEventListener("online", tick);
    return () => { active.current = false; window.clearInterval(id); window.removeEventListener("focus", tick); window.removeEventListener("online", tick); };
  }, [enabled, location, refresh]);
  return { data, busy, error, location, followWindows, stale: !!data && (!!error || now - data.currentAt > WEATHER_STALE_MS), refresh: () => void refresh(true) };
}
export type WeatherModel = ReturnType<typeof useWeather>;
