import { useRef, useState } from "react";
import { formatReplayDateTime } from "./replayDate";

interface ReplayTimelineProps {
  totalBars: number;
  cursorBar: number;
  barTimes: number[];
  /** Continuous update while dragging - cheap, no forced viewport reframe. */
  onScrub: (bar: number) => void;
  /** Fired once the pointer/key interaction settles on a final bar. */
  onCommit: (bar: number) => void;
}

/**
 * A from-scratch replay progress track (not a native <input type="range">)
 * so it can render the "played vs. still-hidden" split the spec asks for -
 * a native range input has no way to style its two sides differently. Drag
 * position maps directly to a bar index, so snapping to a valid candle
 * timestamp is inherent rather than a separate step.
 */
export function ReplayTimeline({ totalBars, cursorBar, barTimes, onScrub, onCommit }: ReplayTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const rafRef = useRef<number | undefined>(undefined);

  const maxBar = Math.max(0, totalBars - 1);
  const pct = maxBar > 0 ? (cursorBar / maxBar) * 100 : 0;

  function barFromClientX(clientX: number): number {
    const el = trackRef.current;
    if (!el) return cursorBar;
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(frac * maxBar);
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (totalBars === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onScrub(barFromClientX(e.clientX));
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const x = e.clientX;
    cancelAnimationFrame(rafRef.current!);
    rafRef.current = requestAnimationFrame(() => onScrub(barFromClientX(x)));
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setDragging(false);
    onCommit(barFromClientX(e.clientX));
  }

  const startLabel = barTimes.length ? formatReplayDateTime(barTimes[0]) : "";
  const endLabel = barTimes.length ? formatReplayDateTime(barTimes[maxBar]) : "";
  const nowLabel = barTimes.length ? formatReplayDateTime(barTimes[Math.min(cursorBar, barTimes.length - 1)]) : "";

  return (
    <div className="rt-wrap">
      <div
        ref={trackRef}
        className={`rt-track${totalBars === 0 ? " disabled" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        role="slider"
        aria-label="Replay progress"
        aria-valuemin={0}
        aria-valuemax={maxBar}
        aria-valuenow={cursorBar}
        aria-valuetext={nowLabel}
        tabIndex={totalBars === 0 ? -1 : 0}
      >
        <div className="rt-played" style={{ width: `${pct}%` }} />
        <div className="rt-future" style={{ left: `${pct}%` }} title="Hidden future data" />
        <div className={`rt-thumb${dragging ? " dragging" : ""}`} style={{ left: `${pct}%` }}>
          <div className="rt-thumb-tip" />
          {dragging && <div className="rt-tooltip mono">{nowLabel}</div>}
        </div>
      </div>
      <div className="rt-labels">
        <span className="rt-label-start mono" title="Replay range start">
          {startLabel}
        </span>
        <span className="rt-label-pct mono">{pct.toFixed(0)}%</span>
        <span className="rt-label-end mono" title="Replay range end">
          {endLabel}
        </span>
      </div>
    </div>
  );
}
