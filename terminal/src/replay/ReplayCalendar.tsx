import { useState } from "react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function dayKey(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

function keyOf(sec: number): number {
  const d = new Date(sec * 1000);
  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Unix seconds at UTC midnight for the given calendar date. */
function dateToSec(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

interface ReplayCalendarProps {
  /** Unix seconds - only the date part is used, to seed the initial month
   * shown and to highlight the currently-selected day. */
  valueSec: number;
  minSec: number;
  maxSec: number;
  /** Fires with unix seconds at UTC midnight for the clicked day - the
   * caller (ReplayDatePicker) merges this with whatever time is already
   * chosen, same as it merges the old native date input's value. */
  onSelect: (daySec: number) => void;
}

/**
 * A compact month-grid calendar, in the app's own dark styling rather than
 * a browser-native <input type="date"> popup (which can't be themed and
 * looks out of place next to the rest of the Replay Bar). Bars don't exist
 * on every calendar day (weekends), so this only constrains the day to
 * [minSec, maxSec]'s date range - landing on a gap still resolves to the
 * nearest real bar the same way typing a date already did.
 */
export function ReplayCalendar({ valueSec, minSec, maxSec, onSelect }: ReplayCalendarProps) {
  const seedDate = new Date(valueSec * 1000);
  const [viewYear, setViewYear] = useState(seedDate.getUTCFullYear());
  const [viewMonth, setViewMonth] = useState(seedDate.getUTCMonth() + 1); // 1-12

  const minDate = new Date(minSec * 1000);
  const maxDate = new Date(maxSec * 1000);
  const minKey = dayKey(minDate.getUTCFullYear(), minDate.getUTCMonth() + 1, minDate.getUTCDate());
  const maxKey = dayKey(maxDate.getUTCFullYear(), maxDate.getUTCMonth() + 1, maxDate.getUTCDate());
  const selectedKey = keyOf(valueSec);
  const todayKey = keyOf(Math.floor(Date.now() / 1000));

  const minYear = minDate.getUTCFullYear();
  const maxYear = maxDate.getUTCFullYear();
  const minMonth = minDate.getUTCMonth() + 1;
  const maxMonth = maxDate.getUTCMonth() + 1;

  const atMinMonth = viewYear === minYear && viewMonth === minMonth;
  const atMaxMonth = viewYear === maxYear && viewMonth === maxMonth;

  function goPrevMonth() {
    if (atMinMonth) return;
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function goNextMonth() {
    if (atMaxMonth) return;
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  // Jumping the year can land on a month that doesn't exist at either end
  // of the dataset (e.g. picking the min year while viewing December) -
  // clamp into whatever months are actually available for the new year,
  // same boundary logic goPrev/NextMonth already respect one step at a time.
  function onYearChange(nextYear: number) {
    const lowMonth = nextYear === minYear ? minMonth : 1;
    const highMonth = nextYear === maxYear ? maxMonth : 12;
    setViewYear(nextYear);
    setViewMonth((m) => Math.min(highMonth, Math.max(lowMonth, m)));
  }

  const yearLowMonth = viewYear === minYear ? minMonth : 1;
  const yearHighMonth = viewYear === maxYear ? maxMonth : 12;
  const monthOptions: number[] = [];
  for (let m = yearLowMonth; m <= yearHighMonth; m++) monthOptions.push(m);
  const yearOptions: number[] = [];
  for (let y = minYear; y <= maxYear; y++) yearOptions.push(y);

  const firstWeekday = (new Date(Date.UTC(viewYear, viewMonth - 1, 1)).getUTCDay() + 6) % 7; // 0=Mon
  const daysInMonth = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="rcal">
      <div className="rcal-header">
        <button type="button" className="rcal-nav" title="Previous month" disabled={atMinMonth} onClick={goPrevMonth}>
          ‹
        </button>
        <div className="rcal-title-selects">
          <select
            className="rcal-select"
            title={MONTH_NAMES[viewMonth - 1]}
            aria-label="Month"
            value={viewMonth}
            onChange={(e) => setViewMonth(Number(e.target.value))}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {MONTH_ABBR[m - 1]}
              </option>
            ))}
          </select>
          <select
            className="rcal-select"
            aria-label="Year"
            value={viewYear}
            onChange={(e) => onYearChange(Number(e.target.value))}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="rcal-nav" title="Next month" disabled={atMaxMonth} onClick={goNextMonth}>
          ›
        </button>
      </div>
      <div className="rcal-weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="rcal-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className="rcal-cell rcal-empty" />;
          const key = dayKey(viewYear, viewMonth, d);
          const disabled = key < minKey || key > maxKey;
          const selected = key === selectedKey;
          const today = key === todayKey;
          return (
            <button
              key={i}
              type="button"
              className={`rcal-cell rcal-day${selected ? " selected" : ""}${today && !selected ? " today" : ""}`}
              disabled={disabled}
              onClick={() => onSelect(dateToSec(viewYear, viewMonth, d))}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
