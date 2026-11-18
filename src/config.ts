import type { WidgetId } from "./nook";
import type { WeatherLocation } from "./weather";
export type AppConfig = { features: { media: boolean; tray: boolean; sharing: boolean; notifications: boolean; activity: boolean }; widgets: WidgetId[]; weatherLocation?: WeatherLocation | null; weatherFollowWindows?: boolean };
export let runtimeConfig: AppConfig = { features: { media: true, tray: true, sharing: true, notifications: true, activity: true }, widgets: ["quicksettings", "sysmon", "calendar", "pomodoro", "lyric", "weather"] };
export function setRuntimeConfig(config: AppConfig) { runtimeConfig = config; }
