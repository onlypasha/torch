import { useEffect, useRef, useState } from "react";

/** Kept above the panel so the wave follows the notch silhouette, not a tile. */
export function TrayDropRipple({ targeted, pulse, visible }: { targeted: boolean; pulse: number; visible: boolean }) {
  const consumed = useRef(pulse);
  const [wave, setWave] = useState<number | null>(null);
  useEffect(() => {
    if (pulse === consumed.current) return;
    consumed.current = pulse;
    setWave(pulse);
  }, [pulse]);
  useEffect(() => { if (!visible) setWave(null); }, [visible]);
  useEffect(() => {
    if (wave === null) return;
    // Backgrounded WebViews may pause CSS frames or skip animationend.
    const timer = window.setTimeout(() => setWave((current) => current === wave ? null : current), 800);
    return () => window.clearTimeout(timer);
  }, [wave]);
  return <div className="notch-tray-ripple" aria-hidden="true">
    {visible && targeted && wave === null && <span className="notch-tray-wave" data-kind="hover" />}
    {visible && wave !== null && <span key={wave} className="notch-tray-wave" data-kind="drop"
      onAnimationEnd={() => setWave((current) => current === wave ? null : current)} />}
  </div>;
}
