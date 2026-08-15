import { useRef, useState } from "react";
import { useReplayStore, SPEEDS } from "./replayStore";
import { ReplayTimeline } from "./ReplayTimeline";
import { ReplayDatePicker } from "./ReplayDatePicker";
import { formatReplayDateTime } from "./replayDate";
import { useCloseOnOutside } from "./useCloseOnOutside";
import "./ReplayBar.css";

/**
 * The dedicated Replay Mode control surface (architecture doc: the Replay
 * Engine in replayStore.ts owns all state; this component only reads it and
 * dispatches transport actions - no bar-slicing or playback timing logic
 * lives here). Mounted only in the primary (non-secondary) ChartPane, so
 * with a multi-timeframe split active there's exactly one bar, floating
 * over the pane that actually owns the shared replay cursor.
 *
 * Renders only the ACTIVE transport bar - the "pick a start point" setup
 * step lives in ReplaySetupMenu, anchored to the TopToolbar's Replay button
 * instead of down here, so the calendar opens right where the user clicked.
 */
export function ReplayBar() {
  const active = useReplayStore((s) => s.active);
  const cursorBar = useReplayStore((s) => s.cursorBar);
  const totalBars = useReplayStore((s) => s.totalBars);
  const barTimes = useReplayStore((s) => s.barTimes);
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const speed = useReplayStore((s) => s.speed);
  const tradeEntryBars = useReplayStore((s) => s.tradeEntryBars);

  const [speedOpen, setSpeedOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const speedRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useCloseOnOutside(speedRef, speedOpen, () => setSpeedOpen(false));
  useCloseOnOutside(dateRef, dateOpen, () => setDateOpen(false));
  useCloseOnOutside(moreRef, moreOpen, () => setMoreOpen(false));

  if (totalBars === 0 || !active) return null;

  const nowSec = barTimes[Math.min(cursorBar, barTimes.length - 1)];

  return (
    <div className="replay-bar">
      <div className="rb-group rb-left">
        <button type="button" className="rb-pill" title="Exit replay - back to live view" onClick={() => useReplayStore.getState().exit()}>
          <span className="rb-pill-dot" />
          REPLAY
        </button>
        <button type="button" className="rb-btn rb-icon" title="Replay start (Home)" onClick={() => useReplayStore.getState().first()}>
          ⏮
        </button>
        <button type="button" className="rb-btn rb-icon" title="Previous bar (←)" onClick={() => useReplayStore.getState().stepBackward()}>
          ‹
        </button>
        <button
          type="button"
          className={`rb-btn rb-icon rb-play${isPlaying ? " active" : ""}`}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          onClick={() => useReplayStore.getState().toggle()}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button type="button" className="rb-btn rb-icon" title="Next bar (→)" onClick={() => useReplayStore.getState().stepForward()}>
          ›
        </button>
        <button type="button" className="rb-btn rb-icon" title="Jump forward (Shift+→)" onClick={() => useReplayStore.getState().bigStepForward()}>
          ⏭
        </button>
      </div>

      <div className="rb-group rb-center">
        <ReplayTimeline
          totalBars={totalBars}
          cursorBar={cursorBar}
          barTimes={barTimes}
          onScrub={(bar) => useReplayStore.getState().scrub(bar)}
          onCommit={(bar) => useReplayStore.getState().seek(bar)}
        />
      </div>

      <div className="rb-group rb-right">
        <div className="rb-anchor" ref={speedRef}>
          <button type="button" className="rb-btn rb-btn-text" title="Playback speed" onClick={() => setSpeedOpen((v) => !v)}>
            {speed}x ▾
          </button>
          {speedOpen && (
            <div className="rb-menu rb-speed-menu">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`rb-menu-item${s === speed ? " active" : ""}`}
                  onClick={() => {
                    useReplayStore.getState().setSpeed(s);
                    setSpeedOpen(false);
                  }}
                >
                  {s}x
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rb-anchor" ref={dateRef}>
          <button type="button" className="rb-btn rb-btn-text rb-date" title="Jump to date &amp; time" onClick={() => setDateOpen((v) => !v)}>
            Replay: {nowSec != null ? formatReplayDateTime(nowSec) : "—"}
          </button>
          {dateOpen && (
            <ReplayDatePicker
              initialSec={nowSec ?? barTimes[barTimes.length - 1]}
              minSec={barTimes[0]}
              maxSec={barTimes[barTimes.length - 1]}
              showQuickNav
              onJump={(sec) => {
                useReplayStore.getState().seekToDate(sec * 1000);
                setDateOpen(false);
              }}
              onPrevDay={() => {
                useReplayStore.getState().seekToDate((nowSec - 86400) * 1000);
                setDateOpen(false);
              }}
              onNextDay={() => {
                useReplayStore.getState().seekToDate((nowSec + 86400) * 1000);
                setDateOpen(false);
              }}
              onPrevSession={() => {
                useReplayStore.getState().prevSession();
                setDateOpen(false);
              }}
              onNextSession={() => {
                useReplayStore.getState().nextSession();
                setDateOpen(false);
              }}
              onClose={() => setDateOpen(false)}
            />
          )}
        </div>

        <div className="rb-anchor" ref={moreRef}>
          <button type="button" className="rb-btn rb-icon" title="More replay controls" onClick={() => setMoreOpen((v) => !v)}>
            ⋯
          </button>
          {moreOpen && (
            <div className="rb-menu rb-more-menu">
              <button
                type="button"
                className="rb-menu-item"
                disabled={tradeEntryBars.length === 0}
                onClick={() => {
                  useReplayStore.getState().prevTrade();
                  setMoreOpen(false);
                }}
              >
                ◂ Previous trade
              </button>
              <button
                type="button"
                className="rb-menu-item"
                disabled={tradeEntryBars.length === 0}
                onClick={() => {
                  useReplayStore.getState().nextTrade();
                  setMoreOpen(false);
                }}
              >
                Next trade ▸
              </button>
              <button
                type="button"
                className="rb-menu-item"
                onClick={() => {
                  useReplayStore.getState().last();
                  setMoreOpen(false);
                }}
              >
                Jump to latest bar (End)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
