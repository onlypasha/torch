import { useEffect, useMemo, useRef, useState } from "react";
import { calendarTitle, compactMonth, DAY_SHORT, weekdayLong } from "./nook";
import "./CalendarWidget.css";

const CELL_WIDTH = 44;
const TODAY_INDEX = 7;

/** BoringCalendar's month/year column and centered, 22-day date wheel. */
export function CalendarWidget() {
  const todayKey = new Date().toDateString();
  const dates = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 22 }, (_, index) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + index - TODAY_INDEX));
  }, [todayKey]);
  const [selected, setSelected] = useState(TODAY_INDEX);
  const wheel = useRef<HTMLDivElement>(null);
  const date = dates[selected];
  const isToday = selected === TODAY_INDEX;

  useEffect(() => {
    setSelected(TODAY_INDEX);
    const node = wheel.current;
    if (!node) return;
    node.scrollLeft = TODAY_INDEX * CELL_WIDTH;
    const scrollDates = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      node.scrollLeft += Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    };
    node.addEventListener("wheel", scrollDates, { passive: false });
    return () => node.removeEventListener("wheel", scrollDates);
  }, [todayKey]);

  const select = (index: number) => {
    setSelected(index);
    wheel.current?.scrollTo({ left: index * CELL_WIDTH,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  return <div className="notch-calendar" role="group" aria-label="Kalender">
    <div className="calendar-heading">
      <button type="button" className="calendar-month" onClick={() => select(TODAY_INDEX)}
        title="Kembali ke hari ini" aria-label={`Kembali ke hari ini, ${calendarTitle(dates[TODAY_INDEX])}`}>
        <span>{compactMonth(date)}</span><span>{date.getFullYear()}</span>
      </button>
      <div className="calendar-wheel-frame">
        <div className="notch-calendar-dates" ref={wheel} role="group" aria-label="Pilih tanggal"
          onPointerDown={(event) => event.stopPropagation()}
          onScroll={(event) => setSelected(Math.max(0, Math.min(21, Math.round(event.currentTarget.scrollLeft / CELL_WIDTH))))}>
          <span className="calendar-wheel-spacer" aria-hidden="true" />
          {dates.map((day, index) => <button type="button" key={day.toDateString()}
            className="calendar-date-button" data-today={index === TODAY_INDEX} aria-current={index === TODAY_INDEX ? "date" : undefined}
            aria-pressed={index === selected} onClick={() => select(index)}
            aria-label={`${weekdayLong(day)}, ${day.getDate()} ${calendarTitle(day)}`}>
            <span className="calendar-weekday">{DAY_SHORT[(day.getDay() + 6) % 7]}</span>
            <span className="calendar-date-number">{day.getDate()}</span>
          </button>)}
          <span className="calendar-wheel-spacer" aria-hidden="true" />
        </div>
      </div>
    </div>
    <div className="calendar-agenda-empty" aria-live="polite">
      <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="16" rx="3" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 14h2M14 14h2M8 17h2" />
      </svg>
      <span>{isToday ? "Hari ini" : `${weekdayLong(date)}, ${date.getDate()} ${compactMonth(date)}`}</span>
      <small>Agenda belum terhubung</small>
    </div>
  </div>;
}
