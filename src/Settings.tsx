import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runtimeConfig } from "./config";
import type { AppConfig } from "./config";
import { WIDGETS, WIDGET_LABEL } from "./nook";
import { WeatherSettings } from "./WeatherSettings";
import "./Settings.css";

function Toggle({ title, detail, checked, disabled, change }: { title: string; detail: string; checked: boolean; disabled?: boolean; change: (value: boolean) => void }) {
  return <label className="config-row"><span><strong>{title}</strong><small>{detail}</small></span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => change(event.target.checked)} /><span className="config-switch" aria-hidden="true" /></label>;
}
export default function Settings() {
  const [config, setConfig] = useState<AppConfig>(() => structuredClone(runtimeConfig));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(config) !== JSON.stringify(runtimeConfig);
  const feature = (key: keyof AppConfig["features"], value: boolean) => setConfig((old) => ({ ...old, features: { ...old.features, [key]: value, ...(key === "tray" && !value ? { sharing: false } : {}), ...(key === "sharing" && value ? { tray: true } : {}) } }));
  const save = async () => { setPending(true); setError(""); try { await invoke("config_save", { config }); } catch (reason) { setError(String(reason)); setPending(false); } };
  return <main className="config-app">
    <aside className="config-sidebar"><div className="config-brand"><span className="config-notch" />NotchApp</div><div className="config-nav">Fitur & widget</div></aside>
    <div className="config-main"><header><h1>Atur notch Anda</h1><p>Pilih fitur yang Anda gunakan. Layanan fitur yang dimatikan tidak dijalankan setelah mulai ulang.</p><button className="config-preset" disabled={pending} onClick={() => setConfig({ features: { media: false, tray: true, sharing: false, notifications: false, activity: false }, widgets: ["quicksettings", "calendar"] })}>Gunakan pilihan ringan</button></header>
      <fieldset disabled={pending}><legend>Fitur</legend><div className="config-group">
        <Toggle title="Media" detail="Kontrol musik, sampul album, dan sinkronisasi lirik." checked={config.features.media} change={(v) => feature("media", v)} />
        <Toggle title="Tray" detail="Penampung file, pratinjau, dan deteksi drag ke notch." checked={config.features.tray} change={(v) => feature("tray", v)} />
        <Toggle title="Sharing" detail="Kirim file dari Tray melalui LocalSend. Mengaktifkan Tray." checked={config.features.sharing} change={(v) => feature("sharing", v)} />
        <Toggle title="Notifikasi" detail="Baca notifikasi Windows dan tampilkan foto WhatsApp." checked={config.features.notifications} change={(v) => feature("notifications", v)} />
        <Toggle title="Aktivitas perangkat" detail="Indikator charger, jaringan, Bluetooth, dan USB." checked={config.features.activity} change={(v) => feature("activity", v)} />
      </div></fieldset>
      <fieldset disabled={pending}><legend>Widget Nook</legend><p className="config-caption">Widget yang dimatikan tidak dimuat dalam tumpukan Nook.</p><div className="config-group">{WIDGETS.map((id) => <Toggle key={id} title={WIDGET_LABEL[id]} detail={{quicksettings:"Kontrol cepat perangkat.",sysmon:"Pembaruan penggunaan CPU, RAM, dan disk.",calendar:"Tanggal dan kalender mingguan.",pomodoro:"Timer fokus dan jeda.",lyric:config.features.media ? "Pencarian lirik yang mengikuti musik." : "Memerlukan fitur Media.",weather:"Informasi cuaca di Nook."}[id]} checked={config.widgets.includes(id)} disabled={id === "lyric" && !config.features.media} change={(value) => setConfig((old) => ({ ...old, widgets: value ? [...old.widgets, id] : old.widgets.filter((widget) => widget !== id) }))} />)}</div></fieldset>
      {config.widgets.includes("weather") && <fieldset disabled={pending}><legend>Lokasi cuaca</legend><WeatherSettings location={config.weatherLocation ?? null} followWindows={config.weatherFollowWindows ?? true} change={(weatherLocation, weatherFollowWindows) => setConfig(old => ({ ...old, weatherLocation, weatherFollowWindows }))} /></fieldset>}
      <footer><div>{error ? <p role="alert" className="config-error">{error}</p> : <p>{dirty ? "Ada perubahan yang belum diterapkan." : "Pengaturan sudah sesuai dengan aplikasi saat ini."}<small>Penggunaan memori juga bergantung pada WebView2.</small></p>}</div><button className="config-save" disabled={!dirty || pending} onClick={() => void save()}>{pending ? "Menerapkan…" : "Simpan dan mulai ulang"}</button></footer>
    </div>
  </main>;
}
