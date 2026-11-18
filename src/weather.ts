export type WeatherLocation = { name: string; latitude: number; longitude: number };
export type WeatherReading = {
  temperature: number;
  condition: string;
  currentAt: number;
  timezone: string;
  hourly: { at: number; label: string; temperature: number }[];
};
export const WEATHER_REFRESH_MS = 15 * 60_000;
export const WEATHER_STALE_MS = 30 * 60_000;

export function weatherCondition(code: number, day: boolean): string {
  const conditions: Record<number, string> = {
    0: day ? "Cerah" : "Malam cerah", 1: "Umumnya cerah", 2: "Cerah berawan", 3: "Mendung",
    45: "Berkabut", 48: "Kabut beku", 51: "Gerimis ringan", 53: "Gerimis", 55: "Gerimis lebat",
    56: "Gerimis beku", 57: "Gerimis beku lebat", 61: "Hujan ringan", 63: "Hujan", 65: "Hujan lebat",
    66: "Hujan beku", 67: "Hujan beku lebat", 71: "Salju ringan", 73: "Salju", 75: "Salju lebat", 77: "Butiran salju",
    80: "Hujan lokal ringan", 81: "Hujan lokal", 82: "Hujan lokal lebat", 85: "Salju lokal", 86: "Salju lokal lebat",
    95: "Badai petir", 96: "Petir dan hujan es", 97: "Badai petir lebat", 99: "Petir dan hujan es lebat",
  };
  return conditions[code] ?? "Kondisi tidak diketahui";
}
function temperature(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -100 && value <= 70;
}
export function weatherTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(at);
}
export function parseWeather(value: unknown, now = Date.now()): WeatherReading {
  const data = value as { timezone?: string; current?: { time?: number; temperature_2m?: unknown; weather_code?: number; is_day?: number }; hourly?: { time?: unknown[]; temperature_2m?: unknown[] } };
  const current = data?.current;
  if (!temperature(current?.temperature_2m) || !Number.isFinite(current?.time)
    || current!.time! <= 0 || current!.time! * 1000 > now + 10 * 60_000 || typeof current?.weather_code !== "number") {
    throw new Error("Data cuaca yang diterima tidak lengkap.");
  }
  const timezone = data.timezone ?? "UTC";
  weatherTime(current!.time! * 1000, timezone);
  const hourly = (data.hourly?.time ?? []).flatMap((at, index) => {
    const degrees = data.hourly?.temperature_2m?.[index];
    if (typeof at !== "number" || !Number.isFinite(at) || at * 1000 <= now || !temperature(degrees)) return [];
    return [{ at: at * 1000, label: weatherTime(at * 1000, timezone), temperature: Math.round(degrees) }];
  }).sort((a, b) => a.at - b.at).slice(0, 4);
  return { temperature: Math.round(current!.temperature_2m as number), condition: weatherCondition(current!.weather_code!, current!.is_day !== 0), currentAt: current!.time! * 1000, timezone, hourly };
}

export function createWeatherLoader(request: (location: WeatherLocation, followWindows: boolean) => Promise<unknown>) {
  let cache: { key: string; data: WeatherReading; until: number } | null = null;
  let flight: { key: string; promise: Promise<WeatherReading> } | null = null;
  return (location: WeatherLocation, followWindows: boolean, force = false): Promise<WeatherReading> => {
    const key = JSON.stringify([location, followWindows]);
    if (flight?.key === key) return flight.promise;
    if (!force && cache?.key === key && cache.until > Date.now()) return Promise.resolve(cache.data);
    const promise = request(location, followWindows).then(value => {
      const data = parseWeather(value);
      cache = { key, data, until: Date.now() + WEATHER_REFRESH_MS };
      return data;
    }).finally(() => { if (flight?.promise === promise) flight = null; });
    flight = { key, promise };
    return promise;
  };
}
