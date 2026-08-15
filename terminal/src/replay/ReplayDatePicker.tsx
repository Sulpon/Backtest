import { useEffect, useRef, useState } from "react";
import { formatReplayDateOnly, formatReplayTimeOnly, parseReplayDateTime } from "./replayDate";
import { ReplayCalendar } from "./ReplayCalendar";

interface ReplayDatePickerProps {
  /** Unix seconds to pre-fill the date/time inputs with. */
  initialSec: number;
  minSec: number;
  maxSec: number;
  onJump: (sec: number) => void;
  onClose: () => void;
  /** Prev/next day + session buttons only make sense once a replay cursor
   * actually exists to step relative to - the initial "pick a start point"
   * setup flow only needs the plain date/time fields. */
  showQuickNav?: boolean;
  onPrevDay?: () => void;
  onNextDay?: () => void;
  onPrevSession?: () => void;
  onNextSession?: () => void;
}

/** A compact popover: a themed month-grid calendar for the date (a native
 * <input type="date"> can't be restyled to match the terminal's own dark
 * chrome, and its popup look is inconsistent across browsers) plus a native
 * time input, which has no such styling problem and stays as-is. */
export function ReplayDatePicker({
  initialSec,
  minSec,
  maxSec,
  onJump,
  onClose,
  showQuickNav,
  onPrevDay,
  onNextDay,
  onPrevSession,
  onNextSession,
}: ReplayDatePickerProps) {
  const [date, setDate] = useState(formatReplayDateOnly(initialSec));
  const [time, setTime] = useState(formatReplayTimeOnly(initialSec));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function jump() {
    const sec = parseReplayDateTime(date, time);
    if (sec == null) return;
    onJump(Math.max(minSec, Math.min(maxSec, sec)));
  }

  const selectedSec = parseReplayDateTime(date, "00:00") ?? initialSec;

  return (
    <div className="rdp" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <ReplayCalendar
        valueSec={selectedSec}
        minSec={minSec}
        maxSec={maxSec}
        onSelect={(daySec) => setDate(formatReplayDateOnly(daySec))}
      />

      <div className="rdp-row">
        <input type="time" className="rdp-input rdp-time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>

      {showQuickNav && (
        <div className="rdp-row rdp-quicknav">
          <button type="button" className="rdp-nav-btn" title="Previous day" onClick={onPrevDay}>
            ◂ Day
          </button>
          <button type="button" className="rdp-nav-btn" title="Next day" onClick={onNextDay}>
            Day ▸
          </button>
          <button type="button" className="rdp-nav-btn" title="Previous session open" onClick={onPrevSession}>
            ◂ Sess
          </button>
          <button type="button" className="rdp-nav-btn" title="Next session open" onClick={onNextSession}>
            Sess ▸
          </button>
        </div>
      )}

      <div className="rdp-row rdp-actions">
        <button type="button" className="rdp-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="rdp-confirm" onClick={jump}>
          Jump
        </button>
      </div>
    </div>
  );
}
