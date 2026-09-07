import { useState } from "react";
import type { PeriodStats } from "../../strategy/analysis/dateAnalytics";
import "./DetailedAnalysis.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Days in a given UTC month (1-12) - same math as replay/ReplayCalendar.tsx. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-first weekday index (0=Mon..6=Sun) of a month's 1st - same math
 * as replay/ReplayCalendar.tsx (that component itself is a date PICKER,
 * not reused directly here, only its grid math). */
function firstWeekdayMondayFirst(year: number, month: number): number {
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}

function dateKeyOf(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

function classify(totalRR: number, count: number): "pos" | "neg" | "neutral" {
  if (count === 0 || totalRR === 0) return "neutral";
  return totalRR > 0 ? "pos" : "neg";
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}R`;
}

interface DailyPerformanceCalendarProps {
  /** Keyed by "YYYY-MM-DD" (exitDateParts.dateKey) - see dateAnalytics.ts. */
  dailyMap: Map<string, PeriodStats>;
  defaultYear: number;
  /** 1-12. */
  defaultMonth: number;
}

/** Free navigation, same reasoning as MonthlyPerformanceWidget - no
 * min/max clamping to available data. */
export function DailyPerformanceCalendar({ dailyMap, defaultYear, defaultMonth }: DailyPerformanceCalendarProps) {
  const [viewYear, setViewYear] = useState(defaultYear);
  const [viewMonth, setViewMonth] = useState(defaultMonth);

  function goPrev() {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  }
  function goNext() {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }
  function goToday() {
    const now = new Date();
    setViewYear(now.getUTCFullYear());
    setViewMonth(now.getUTCMonth() + 1);
  }

  const leading = firstWeekdayMondayFirst(viewYear, viewMonth);
  const total = daysInMonth(viewYear, viewMonth);
  const cells: (number | null)[] = [...Array(leading).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Daily Performance</span>
        <div className="da-month-nav">
          <button type="button" className="da-nav-btn" onClick={goPrev} title="Previous month">
            ‹
          </button>
          <span className="mono da-month-label">
            {MONTH_NAMES[viewMonth - 1]} {viewYear}
          </span>
          <button type="button" className="da-nav-btn" onClick={goNext} title="Next month">
            ›
          </button>
          <button type="button" className="da-today-btn" onClick={goToday}>
            Today
          </button>
        </div>
      </div>
      <div className="da-day-grid-header">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="da-day-label">
            {w}
          </div>
        ))}
      </div>
      <div className="da-day-grid">
        {cells.map((day, i) => {
          if (day == null) return <div key={i} className="da-cell da-cell-blank" />;
          const stats = dailyMap.get(dateKeyOf(viewYear, viewMonth, day));
          const totalRR = stats?.totalRR ?? 0;
          const count = stats?.count ?? 0;
          return (
            <div key={i} className={`da-cell ${classify(totalRR, count)}`}>
              <div className="da-cell-date">{day}</div>
              <div className="da-cell-rr mono">{count === 0 ? "0.0R" : signed(totalRR)}</div>
              <div className="da-cell-count">
                {count} {count === 1 ? "trade" : "trades"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
