import { useEffect, useRef, useState } from "react";
import { useReplayStore } from "./replayStore";
import { ReplayCalendar } from "./ReplayCalendar";
import { formatReplayDateOnly, formatReplayDateTime, formatReplayTimeOnly, parseReplayDateTime } from "./replayDate";
import { nearestIndexByTime } from "../lib/bars";
import "./ReplayBar.css";

/**
 * The "pick a start point" popover, anchored to the TopToolbar's Replay
 * button (architecture doc: replayStore owns setupArmed/pendingBar, this
 * only reads and dispatches). Two ways to pick land on the same
 * pendingBar: clicking a candle on the chart (ChartPane's click subscriber
 * calls pickBar directly) or the calendar/time fields here - either one
 * updates the store, and this menu's fields stay in sync with whichever
 * happened last via the effect below.
 */
export function ReplaySetupMenu() {
  const pendingBar = useReplayStore((s) => s.pendingBar);
  const barTimes = useReplayStore((s) => s.barTimes);
  const rootRef = useRef<HTMLDivElement>(null);

  // Not the shared useCloseOnOutside: picking a candle on the chart is a
  // legitimate second input surface for THIS SAME popover (ChartPane's
  // click subscriber calls pickBar while setupArmed), not a dismissal, so
  // a click landing there must not cancel setup out from under it. Clicks
  // on the Replay button itself are also excluded - that button already
  // toggles the menu closed on its own, and without this the mousedown
  // here would close it a tick before the button's own click handler
  // re-opens it, producing a stuck-open menu from the user's point of view.
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (rootRef.current?.contains(target)) return;
      if (target.closest(".pane-chart") || target.closest(".tb-replay-entry")) return;
      useReplayStore.getState().cancelSetup();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") useReplayStore.getState().cancelSetup();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const fallbackSec = barTimes.length ? barTimes[barTimes.length - 1] : 0;
  const seedSec = pendingBar != null ? barTimes[pendingBar] : fallbackSec;

  const [date, setDate] = useState(formatReplayDateOnly(seedSec));
  const [time, setTime] = useState(formatReplayTimeOnly(seedSec));

  // A chart click picked (or re-picked) a bar - reflect it in the fields
  // without fighting the user's own in-progress edits here.
  useEffect(() => {
    if (pendingBar == null || barTimes.length === 0) return;
    const sec = barTimes[pendingBar];
    setDate(formatReplayDateOnly(sec));
    setTime(formatReplayTimeOnly(sec));
  }, [pendingBar, barTimes]);

  function commit(nextDate: string, nextTime: string) {
    if (barTimes.length === 0) return;
    const sec = parseReplayDateTime(nextDate, nextTime);
    if (sec == null) return;
    const bar = nearestIndexByTime(barTimes, sec, (t) => t);
    if (bar >= 0) useReplayStore.getState().pickBar(bar);
  }

  if (barTimes.length === 0) return null;

  return (
    <div className="rsm" ref={rootRef} onMouseDown={(e) => e.stopPropagation()}>
      <div className="rsm-hint">
        {pendingBar != null ? `Start replay at ${formatReplayDateTime(barTimes[pendingBar])}` : "Click a candle on the chart, or pick a date below"}
      </div>

      <ReplayCalendar
        valueSec={seedSec}
        minSec={barTimes[0]}
        maxSec={barTimes[barTimes.length - 1]}
        onSelect={(daySec) => {
          const nextDate = formatReplayDateOnly(daySec);
          setDate(nextDate);
          commit(nextDate, time);
        }}
      />

      <input
        type="time"
        className="rsm-time"
        value={time}
        onChange={(e) => {
          setTime(e.target.value);
          commit(date, e.target.value);
        }}
      />

      <div className="rsm-actions">
        <button type="button" className="rdp-cancel" title="Cancel (Esc)" onClick={() => useReplayStore.getState().cancelSetup()}>
          Cancel
        </button>
        <button
          type="button"
          className="rdp-confirm"
          disabled={pendingBar == null}
          title="Start Replay Here"
          onClick={() => useReplayStore.getState().confirmSetup()}
        >
          Start Replay Here
        </button>
      </div>
    </div>
  );
}
