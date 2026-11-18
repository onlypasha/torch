import { invoke } from "@tauri-apps/api/core";
import type { WeatherModel } from "./useWeather";
import { weatherTime } from "./weather";

export function WeatherWidget({ weather, compact = false }: { weather: WeatherModel; compact?: boolean }) {
  const { data, location, busy, error, stale } = weather;
  if (compact) return <div className="notch-pin-weather" title={error || location?.name}>
    {data ? <><span className="notch-pin-weather-temp">{data.temperature}°</span><span className="notch-pin-weather-condition">{stale ? "Data lama" : data.condition}</span></>
      : <span className="notch-pin-weather-condition">{!location ? "Atur lokasi" : busy ? "Memuat…" : "Tidak tersedia"}</span>}
  </div>;
  if (!data) return <div className="notch-weather-empty" aria-busy={busy}>
    <span className="notch-widget-label" title={location?.name}>{location?.name ?? "Cuaca"}</span>
    <div className="notch-weather-notice">
      <p role="status" title={error}>{!location ? "Pilih lokasi untuk melihat cuaca." : busy ? "Memuat cuaca…" : "Cuaca belum tersedia. Periksa koneksi dan lokasi."}</p>
      <div className="notch-weather-actions">
        {!!location && !busy && <button type="button" onClick={weather.refresh}>Coba lagi</button>}
        {!busy && <button type="button" onClick={() => void invoke("config_open").catch(() => {})}>Atur lokasi</button>}
      </div>
    </div>
  </div>;
  const time = weatherTime(data.currentAt, data.timezone);
  return <div className="notch-weather" aria-busy={busy}>
    <div className="notch-weather-header">
      <span className="notch-widget-label" title={location?.name}>{location?.name ?? "Cuaca"}</span>
      <button className="notch-weather-source" type="button" title="Sumber data cuaca Open-Meteo" onClick={() => void invoke("weather_open_source").catch(() => {})}>Open-Meteo</button>
    </div>
    <div className="notch-weather-now">
      <span className="notch-weather-temp"><span aria-hidden="true">{data.temperature}°</span><span className="sr-only">{data.temperature} derajat Celsius</span></span>
      <span className="notch-weather-detail"><span className="notch-weather-condition">{data.condition}</span><small title={error || `Waktu data dalam zona ${data.timezone}`}>{stale ? "Data lama" : "Data"} · {time}</small></span>
    </div>
    <div className="notch-weather-hours" role="group" aria-label="Prakiraan per jam">
      {data.hourly.length ? data.hourly.map(hour => <span key={hour.at} className="notch-weather-hour"><span className="notch-weather-hour-label">{hour.label}</span><span className="notch-weather-hour-temp">{hour.temperature}°</span></span>) : <span className="notch-weather-hour-label">Prakiraan belum tersedia</span>}
    </div>
  </div>;
}
