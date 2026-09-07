import { useEffect, useRef, useState } from "react";
import { TradesPanel } from "./panels/TradesPanel";
import { StatsPanel } from "./panels/StatsPanel";
import { StrategyPanel } from "./panels/StrategyPanel";
import { DetailedAnalysisPanel } from "./panels/DetailedAnalysisPanel";
import { MonteCarloPanel } from "./panels/MonteCarloPanel";
import "./BottomPanel.css";

type BottomTab = "trades" | "stats" | "strategy" | "detailed" | "montecarlo";

// TradesPanel already IS the combined Trades+Journal view (expand a row to
// star/tag/note it - see that file) and StatsPanel already IS the combined
// Performance+Statistics view, so those two stay single tabs rather than
// splitting further - "Strategy"/"Detailed Analysis"/"Monte Carlo" each
// add their own genuinely distinct dedicated view (historical scan config,
// exit-time analytics, simulation), so they're separate tabs.
const TABS: { id: BottomTab; label: string }[] = [
  { id: "trades", label: "Trades & Journal" },
  { id: "stats", label: "Performance" },
  { id: "strategy", label: "Strategy" },
  { id: "detailed", label: "Detailed Analysis" },
  { id: "montecarlo", label: "Monte Carlo" },
];

const STORAGE_KEY = "terminal.bottomPanelHeight";
// Matches --bottompanel-h in theme/tokens.css - the same default the panel
// already used before it became resizable.
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
// AppShell.css makes .app-body (the chart/dock area + sidebar) `flex: 1`,
// so growing this panel automatically shrinks the chart with zero extra
// wiring - ChartPane's own ResizeObserver already reacts to its container
// shrinking/growing. This reserve just keeps at least some chart visible -
// matches --topbar-h (44) + --statusbar-h (24) + this panel's own 28px tab
// bar, plus a 160px floor for the chart itself.
const CHROME_HEIGHT = 44 + 24 + 28;
const MIN_CHART_HEIGHT = 160;

function loadSavedHeight(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function maxHeightForViewport(): number {
  return Math.max(MIN_HEIGHT, window.innerHeight - CHROME_HEIGHT - MIN_CHART_HEIGHT);
}

/**
 * TradingView-style collapsible bottom panel - full width, sits below
 * both the left rail and the right sidebar (see AppShell.tsx). Reuses
 * `<TradesPanel/>`/`<StatsPanel/>` verbatim (same components already
 * dockable via the Replay/Review/Research/Journal workspace presets - see
 * DockviewRoot.tsx's seedLayout) as a second, always-available home for
 * them, not a replacement for that dockview-hosted path.
 *
 * Resizable via a drag handle at the top of the body: dragging updates the
 * DOM height directly (bodyRef) on every mousemove for a smooth drag with
 * no React re-render per pixel - the same reasoning ChartPane's own
 * ResizeObserver-driven resize already uses - and only commits the final
 * value to React state (and localStorage, so it survives a reload) once on
 * mouseup.
 */
export function BottomPanel() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<BottomTab>("trades");
  const [height, setHeight] = useState(loadSavedHeight);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function selectTab(tab: BottomTab) {
    if (open && activeTab === tab) {
      setOpen(false);
      return;
    }
    setActiveTab(tab);
    setOpen(true);
  }

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    dragStateRef.current = { startY: e.clientY, startHeight: height };
    setDragging(true);
  }

  useEffect(() => {
    if (!dragging) return;

    function handleMouseMove(e: MouseEvent) {
      const drag = dragStateRef.current;
      if (!drag || !bodyRef.current) return;
      // Dragging the handle UP (smaller clientY) grows the panel.
      const delta = drag.startY - e.clientY;
      const next = Math.min(maxHeightForViewport(), Math.max(MIN_HEIGHT, drag.startHeight + delta));
      bodyRef.current.style.height = `${next}px`;
    }

    function handleMouseUp() {
      const finalHeight = bodyRef.current ? bodyRef.current.getBoundingClientRect().height : height;
      setHeight(finalHeight);
      try {
        localStorage.setItem(STORAGE_KEY, String(finalHeight));
      } catch {
        // best-effort only - a failed write just means the size resets to
        // the last successfully-saved (or default) height next reload.
      }
      dragStateRef.current = null;
      setDragging(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  return (
    <div className="bottom-panel">
      <div className="bottom-panel-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`bottom-panel-tab${open && activeTab === t.id ? " active" : ""}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="bottom-panel-spacer" />
        <button
          type="button"
          className="bottom-panel-collapse"
          title={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▴"}
        </button>
      </div>
      {open && (
        <>
          <div
            className={`bottom-panel-resize-handle${dragging ? " dragging" : ""}`}
            onMouseDown={handleResizeStart}
            title="Drag to resize"
          />
          <div ref={bodyRef} className="bottom-panel-body" style={{ height }}>
            {activeTab === "trades" && <TradesPanel />}
            {activeTab === "stats" && <StatsPanel />}
            {activeTab === "strategy" && <StrategyPanel />}
            {activeTab === "detailed" && <DetailedAnalysisPanel />}
            {activeTab === "montecarlo" && <MonteCarloPanel />}
          </div>
        </>
      )}
    </div>
  );
}
