import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WeatherLocation } from "./weather";

export function WeatherSettings({ location, followWindows, change }: { location: WeatherLocation | null; followWindows: boolean; change: (location: WeatherLocation, followWindows: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherLocation[]>([]);
  const [pending, setPending] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const token = useRef(0);
  const search = async () => {
    const request = ++token.current;
    setPending(true); setError(""); setSearched(false); setResults([]);
    try {
      const found = await invoke<WeatherLocation[]>("weather_search", { query: query.trim() });
      if (request === token.current) { setResults(found); setSearched(true); }
    } catch (reason) { if (request === token.current) setError(String(reason)); }
    finally { if (request === token.current) setPending(false); }
  };
  const windows = async () => {
    setPending(true); setError("");
    try { change(await invoke<WeatherLocation>("weather_windows_location"), true); setResults([]); setSearched(false); }
    catch (reason) { setError(String(reason)); }
    finally { setPending(false); }
  };
  return <div className="config-weather">
    <p>Lokasi dipilih: <strong>{location?.name ?? "Belum diatur"}</strong></p>
    <button type="button" className="config-weather-windows" disabled={pending} aria-pressed={!!location && followWindows} onClick={() => void windows()}>Gunakan lokasi Windows</button>
    <p className="config-weather-detail">Windows akan meminta izin lokasi. Koordinat perkiraan dikirim ke Open-Meteo untuk mengambil cuaca. Lokasi dibaca ulang setiap pembaruan.</p>
    <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <label htmlFor="weather-city">Atau cari kota manual</label>
      <div className="config-weather-search"><input id="weather-city" type="search" value={query} placeholder="Nama kota" minLength={2} maxLength={120} disabled={pending} onChange={event => { token.current++; setQuery(event.target.value); setResults([]); setSearched(false); }} /><button type="submit" disabled={pending || query.trim().length < 2}>{pending ? "Memeriksa…" : "Cari"}</button></div>
    </form>
    {error && <p role="alert" className="config-error">{error}</p>}
    {searched && !results.length && <p role="status">Kota tidak ditemukan. Coba nama kota dan negara.</p>}
    {results.length > 0 && <ul className="config-weather-results" aria-label="Hasil pencarian kota">{results.map(result => <li key={`${result.latitude},${result.longitude}`}><button type="button" onClick={() => { change(result, false); setResults([]); setSearched(false); }}>{result.name}</button></li>)}</ul>}
    <p className="config-weather-detail">Cuaca dan prakiraan Open-Meteo dalam Celsius, diperbarui tiap 15 menit. Simpan pengaturan untuk menerapkan lokasi.</p>
  </div>;
}
