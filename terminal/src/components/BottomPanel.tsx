import { useState } from "react";
import { TradesPanel } from "./panels/TradesPanel";
import { StatsPanel } from "./panels/StatsPanel";
import "./BottomPanel.css";

type BottomTab = "trades" | "stats";

// Only 2 tabs, not 4 - TradesPanel already IS the combined Trades+Journal
// view (expand a row to star/tag/note it - see that file) and StatsPanel
// already IS the combined Performance+Statistics view. Labeling them as 4
// separate tabs would imply 4 distinct panels that don't exist.
const TABS: { id: BottomTab; label: string }[] = [
  { id: "trades", label: "Trades & Journal" },
  { id: "stats", label: "Performance" },
];

/**
 * TradingView-style collapsible bottom panel - full width, sits below
 * both the left rail and the right sidebar (see AppShell.tsx). Reuses
 * `<TradesPanel/>`/`<StatsPanel/>` verbatim (same components already
 * dockable via the Replay/Review/Research/Journal workspace presets - see
 * DockviewRoot.tsx's seedLayout) as a second, always-available home for
 * them, not a replacement for that dockview-hosted path.
 */
export function BottomPanel() {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<BottomTab>("trades");

  function selectTab(tab: BottomTab) {
    if (open && activeTab === tab) {
      setOpen(false);
      return;
    }
    setActiveTab(tab);
    setOpen(true);
  }

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
        <div className="bottom-panel-body">
          {activeTab === "trades" && <TradesPanel />}
          {activeTab === "stats" && <StatsPanel />}
        </div>
      )}
    </div>
  );
}
