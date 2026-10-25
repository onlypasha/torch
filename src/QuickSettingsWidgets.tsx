import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";

export type SysStats = {
  cpuPercent: number;
  memPercent: number;
  memUsedGb: number;
  memTotalGb: number;
  diskPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  diskLabel: string;
};

export type QuickState = {
  brightness: number;
  brightnessSupported: boolean;
  dnd: boolean;
  dndSupported: boolean;
};

// ---------------------------------------------------------------------------
// Quick Settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SVG Icons for Quick Settings
// ---------------------------------------------------------------------------

function DndIcon({ active }: { active: boolean }) {
  if (active) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function SleepIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function HibernateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      <path d="M16 6h4l-4 4h4" />
    </svg>
  );
}

/** Speaker with two arcs, or with a slash when the endpoint is muted. */
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {muted ? (
        <>
          <line x1="17" y1="9" x2="23" y2="15" />
          <line x1="23" y1="9" x2="17" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

/** Sun over a horizon: the brightness slider's glyph. */
function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function QuickSettingsWidget() {
  const [vol, setVol] = useState<{ level: number; muted: boolean }>({ level: 0.5, muted: false });
  const [bright, setBright] = useState(50);
  const [dnd, setDnd] = useState(false);
  const [powerMenu, setPowerMenu] = useState(false);

  useEffect(() => {
    void invoke<{ level: number; muted: boolean }>("volume_get")
      .then((res) => setVol(res))
      .catch(() => {});
    void invoke<QuickState>("quicksettings_get")
      .then((qs) => {
        setBright(qs.brightness);
        setDnd(qs.dnd);
      })
      .catch(() => {});
  }, []);

  const handleVolume = useCallback((val: number) => {
    setVol((prev) => ({ ...prev, level: val }));
    void invoke("volume_set", { level: val, muted: val === 0 }).catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !vol.muted;
    setVol((prev) => ({ ...prev, muted: nextMuted }));
    void invoke("volume_set", { level: vol.level, muted: nextMuted }).catch(() => {});
  }, [vol]);

  const handleBrightness = useCallback((val: number) => {
    setBright(val);
    void invoke("brightness_set", { value: val }).catch(() => {});
  }, []);

  const toggleDnd = useCallback(() => {
    void invoke<boolean>("dnd_toggle")
      .then((res) => setDnd(res))
      .catch(() => setDnd((prev) => !prev));
  }, []);

  const handleLock = useCallback(() => {
    void invoke("system_lock").catch(() => {});
  }, []);

  const handleSleep = useCallback(() => {
    void invoke("system_sleep").catch(() => {});
  }, []);

  const handleHibernate = useCallback(() => {
    void invoke("system_hibernate").catch(() => {});
  }, []);

  const handleShutdown = useCallback(() => {
    void invoke("system_shutdown").catch(() => {});
  }, []);

  return (
    <div className="notch-qs-widget">
      <AnimatePresence mode="wait">
        {powerMenu ? (
          <motion.div
            key="power"
            className="notch-qs-power-view"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <div className="notch-qs-power-head">
              <button
                type="button"
                className="notch-qs-power-back"
                onClick={() => setPowerMenu(false)}
                aria-label="Kembali"
                title="Kembali"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="notch-qs-power-grid">
              <button
                type="button"
                className="notch-qs-power-btn"
                onClick={handleSleep}
                aria-label="Sleep"
                title="Sleep"
              >
                <SleepIcon />
              </button>
              <button
                type="button"
                className="notch-qs-power-btn"
                onClick={handleHibernate}
                aria-label="Hibernasi"
                title="Hibernasi"
              >
                <HibernateIcon />
              </button>
              <button
                type="button"
                className="notch-qs-power-btn notch-qs-danger"
                onClick={handleShutdown}
                aria-label="Matikan komputer"
                title="Matikan"
              >
                <PowerIcon />
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="controls"
            className="notch-qs-main-view"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {/* Slider Volume */}
            <div className="notch-qs-row">
              <button
                type="button"
                className="notch-qs-icon-btn"
                onClick={toggleMute}
                aria-label={vol.muted ? "Bunyikan audio" : "Senyapkan audio"}
              >
                <SpeakerIcon muted={vol.muted || vol.level === 0} />
              </button>
              <input
                type="range"
                className="notch-qs-slider"
                min={0}
                max={100}
                value={vol.muted ? 0 : Math.round(vol.level * 100)}
                onChange={(e) => handleVolume(Number(e.target.value) / 100)}
                aria-label="Volume"
              />
              <span className="notch-qs-value">{vol.muted ? "Mute" : `${Math.round(vol.level * 100)}%`}</span>
            </div>

            {/* Slider Kecerahan */}
            <div className="notch-qs-row">
              <span className="notch-qs-icon" aria-hidden="true"><SunIcon /></span>
              <input
                type="range"
                className="notch-qs-slider"
                min={0}
                max={100}
                value={bright}
                onChange={(e) => handleBrightness(Number(e.target.value))}
                aria-label="Kecerahan layar"
              />
              <span className="notch-qs-value">{bright}%</span>
            </div>

            {/* Tombol Aksi */}
            <div className="notch-qs-actions">
              <button
                type="button"
                className={`notch-qs-btn${dnd ? " active" : ""}`}
                onClick={toggleDnd}
                aria-pressed={dnd}
                aria-label={dnd ? "Nonaktifkan DND" : "Aktifkan DND"}
                title={dnd ? "DND Aktif" : "DND Mati"}
              >
                <DndIcon active={dnd} />
              </button>
              <button
                type="button"
                className="notch-qs-btn"
                onClick={handleLock}
                aria-label="Kunci Layar"
                title="Kunci Layar"
              >
                <LockIcon />
              </button>
              <button
                type="button"
                className="notch-qs-btn"
                onClick={() => setPowerMenu(true)}
                aria-label="Buka menu daya"
                title="Menu Daya"
              >
                <PowerIcon />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System Monitor (Tiga Cincin)
// ---------------------------------------------------------------------------

function RingGauge({
  percent,
  label,
  valueText,
  subText,
}: {
  percent: number;
  label: string;
  valueText: string;
  subText?: string;
}) {
  const radius = 22;
  const stroke = 3.5;
  const circ = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circ - (clamped / 100) * circ;

  return (
    <div className="notch-sysmon-ring-item">
      <div className="notch-sysmon-svg-wrap">
        <svg width="56" height="56" viewBox="0 0 56 56" className="notch-sysmon-svg">
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={stroke}
          />
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 28 28)"
            className={`notch-sysmon-fill${clamped > 85 ? " high" : ""}`}
          />
        </svg>
        <span className="notch-sysmon-center-pct">{valueText}</span>
      </div>
      <span className="notch-sysmon-label">{label}</span>
      {subText && <span className="notch-sysmon-sub">{subText}</span>}
    </div>
  );
}

export function SystemMonitorWidget() {
  const [stats, setStats] = useState<SysStats>({
    cpuPercent: 0,
    memPercent: 0,
    memUsedGb: 0,
    memTotalGb: 0,
    diskPercent: 0,
    diskUsedGb: 0,
    diskTotalGb: 0,
    diskLabel: "C:",
  });

  useEffect(() => {
    let unmounted = false;
    const fetchStats = () => {
      void invoke<SysStats>("sysinfo_stats")
        .then((res) => {
          if (!unmounted) setStats(res);
        })
        .catch(() => {});
    };

    fetchStats();
    const id = setInterval(fetchStats, 1000);
    return () => {
      unmounted = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="notch-sysmon-widget">
      <div className="notch-sysmon-rings">
        <RingGauge
          percent={stats.cpuPercent}
          label="CPU"
          valueText={`${Math.round(stats.cpuPercent)}%`}
        />
        <RingGauge
          percent={stats.memPercent}
          label="RAM"
          valueText={`${Math.round(stats.memPercent)}%`}
          subText={`${stats.memUsedGb.toFixed(1)}G`}
        />
        <RingGauge
          percent={stats.diskPercent}
          label={`Disk (${stats.diskLabel})`}
          valueText={`${Math.round(stats.diskPercent)}%`}
          subText={`${Math.round(stats.diskUsedGb)}G`}
        />
      </div>
    </div>
  );
}
