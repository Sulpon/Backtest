import { useEffect, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { useActiveWorkspace, useWorkspaceStore } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { useFocusedChartPane } from "../workspace/useFocusedChartPane";
import { useReplayStore } from "../replay/replayStore";
import { ReplaySetupMenu } from "../replay/ReplaySetupMenu";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../data/timeframes";
import type { Timeframe } from "../data/types";
import { useSymbols } from "../data/useSymbols";
import { applyChartLayout, countChartPanels } from "./chartLayout";
import "./TopToolbar.css";

/** Pane counts the layout picker offers - any dockview panel count works via
 * applyChartLayout, this is just which buttons are shown. */
const LAYOUT_PANE_COUNTS = [1, 2, 4, 8, 16];

type ChartType = "candles" | "line" | "area";
const CHART_TYPES: { id: ChartType; glyph: string; label: string }[] = [
  { id: "candles", glyph: "▤", label: "Candles" },
  { id: "line", glyph: "╱", label: "Line" },
  { id: "area", glyph: "◭", label: "Area" },
];

export function TopToolbar() {
  const ws = useActiveWorkspace();
  const setWorkspaceSymbol = useWorkspaceStore((s) => s.setSymbol);
  const setWorkspaceTimeframe = useWorkspaceStore((s) => s.setTimeframe);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const saveAsWorkspace = useWorkspaceStore((s) => s.saveAsWorkspace);
  const setHint = useUiStore((s) => s.setStatusHint);
  const activeToolId = useUiStore((s) => s.activeToolId);
  const pendingRR = useUiStore((s) => s.pendingRR);
  const setPendingRR = useUiStore((s) => s.setPendingRR);
  const analysisHubOpen = useUiStore((s) => s.analysisHubOpen);
  const setAnalysisHubOpen = useUiStore((s) => s.setAnalysisHubOpen);
  const marketStructureDatasetOpen = useUiStore((s) => s.marketStructureDatasetOpen);
  const setMarketStructureDatasetOpen = useUiStore((s) => s.setMarketStructureDatasetOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const dockviewApi = useUiStore((s) => s.dockviewApi);
  const { theme, toggleTheme } = useTheme();
  const [layout, setLayoutLocal] = useState(1);
  const symbols = useSymbols();

  // Every pane owns its own symbol/timeframe now (ChartPaneParams) - this
  // toolbar control acts on whichever pane currently has dockview focus,
  // falling back to the workspace default when no chart pane is focused
  // (e.g. a Watchlist/Trades panel is active, or the dock hasn't mounted a
  // panel yet). That fallback also seeds any newly-created pane.
  const focused = useFocusedChartPane(dockviewApi);
  const displaySymbol = focused.symbol ?? ws.symbol;
  const displayTimeframe = focused.timeframe ?? ws.timeframe;

  function handleSymbolChange(symbol: string) {
    if (focused.panelApi) focused.panelApi.updateParameters({ symbol, timeframe: displayTimeframe });
    else setWorkspaceSymbol(symbol);
  }
  function handleTimeframeChange(timeframe: Timeframe) {
    if (focused.panelApi) focused.panelApi.updateParameters({ symbol: displaySymbol, timeframe });
    else setWorkspaceTimeframe(timeframe);
  }

  // Every pane beyond chart-1 starts on displaySymbol, cycling forward
  // through TIMEFRAMES from displayTimeframe's own slot (wrapping with
  // modulo past 7 panes) - see chartLayout.ts's timeframeForPaneIndex for
  // the exact scheme. Positions build a 2-column grid (pane 2 right of
  // chart-1, everything after that below the pane two slots back) rather
  // than cascading N panes in one unreadable row - see positionForPane.
  // Since every pane owns its own symbol/timeframe (ChartPaneParams), all
  // of this is just a starting point the user can change per-pane right
  // after.
  function applyLayout(n: number) {
    const api = dockviewApi;
    if (!api) {
      setLayoutLocal(n);
      return;
    }
    const resultCount = applyChartLayout(api, n, displaySymbol, displayTimeframe);
    setLayoutLocal(resultCount);
  }

  // dockviewApi's panel set can also change from outside this control (a
  // pane closed via its own tab X, a workspace switch restoring a saved
  // layout, command palette's split/collapse commands) - resync the
  // highlighted button from the actual pane count rather than trusting
  // whatever applyLayout last set optimistically. Mirrors watchlistOpen's
  // onDidLayoutChange subscription below.
  useEffect(() => {
    if (!dockviewApi) return;
    const sync = () => setLayoutLocal(countChartPanels(dockviewApi));
    sync();
    const disposable = dockviewApi.onDidLayoutChange(sync);
    return () => disposable.dispose();
  }, [dockviewApi]);

  const replay = useReplayStore();

  // dockviewApi itself never changes when a panel is added/removed (same
  // instance throughout), so this needs its own subscription to stay in
  // sync - onDidLayoutChange already fires on exactly that (DockviewRoot
  // uses the same event to persist the layout), which is simpler than a
  // dedicated add/remove-panel listener pair for one panel id.
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  useEffect(() => {
    if (!dockviewApi) {
      setWatchlistOpen(false);
      return;
    }
    const sync = () => setWatchlistOpen(!!dockviewApi.getPanel("watchlist-1"));
    sync();
    const disposable = dockviewApi.onDidLayoutChange(sync);
    return () => disposable.dispose();
  }, [dockviewApi]);

  function toggleWatchlist() {
    const api = dockviewApi;
    if (!api) return;
    const existing = api.getPanel("watchlist-1");
    if (existing) {
      api.removePanel(existing);
      return;
    }
    api.addPanel({
      id: "watchlist-1",
      component: "watchlist",
      title: "Watchlist",
      position: { referencePanel: "chart-1", direction: "right" },
      initialWidth: 260,
    });
  }

  // Visually present per the target TradingView-style toolbar, deliberately
  // NOT wired to the chart yet - switching series type touches the
  // candlestick series' reference identity, which every attached drawing
  // primitive and the swing/BOS marker plugin key off of. That's a real,
  // separate, testable change; folding it into a UI-only redesign risks
  // regressing the drawing-primitive system the last 3 phases verified.
  // Same honest "visible, armable-looking, but tells you it's not built
  // yet" pattern already established for placeholder drawing tools (see
  // LeftToolRail.tsx's pickTool()).
  const [chartType, setChartTypeLocal] = useState<ChartType>("candles");
  function pickChartType(type: ChartType) {
    if (type === "candles") {
      setChartTypeLocal(type);
      return;
    }
    setHint(`${CHART_TYPES.find((c) => c.id === type)?.label} chart type isn't wired up yet - Candles only for now`);
  }

  // Fullscreen is plain browser API, no app state of its own to own - this
  // only mirrors document.fullscreenElement so the button's active state
  // stays correct when the user exits via Esc (browser-native), not just
  // via this button.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);
  function toggleFullscreen() {
    // Both are real rejecting Promises, not fire-and-forget calls - the
    // Fullscreen API rejects (a real, reproducible case, not hypothetical)
    // when the request wasn't triggered by a trusted user gesture, or when
    // a permissions policy denies it (e.g. an iframe without
    // allow="fullscreen"). Uncaught, that surfaces as an unhandled promise
    // rejection in the console; caught here and surfaced the same way
    // every other "can't do that right now" case in this toolbar already
    // is (setHint), rather than crashing or silently doing nothing.
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    request.catch(() => setHint("Fullscreen isn't available right now (blocked by the browser or an embedding policy)"));
  }

  return (
    <div className="topbar">
      <div className="tb-group">
        <span className="tb-brand">◆ TERMINAL</span>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <select
          className="tb-select"
          value={displaySymbol}
          onChange={(e) => handleSymbolChange(e.target.value)}
          title={focused.panelApi ? "Instrument (focused pane)" : "Instrument (new panes start here)"}
        >
          {(symbols.length ? symbols : [displaySymbol]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="tb-tf">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className={tf === displayTimeframe ? "active" : ""}
              onClick={() => handleTimeframeChange(tf)}
            >
              {TIMEFRAME_LABELS[tf]}
            </button>
          ))}
        </div>
        <div className="tb-tf tb-chart-type">
          {CHART_TYPES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === chartType ? "active" : ""}
              title={c.id === "candles" ? "Candlestick chart" : `${c.label} chart - coming soon`}
              onClick={() => pickChartType(c.id)}
            >
              {c.glyph}
            </button>
          ))}
        </div>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <div className="tb-replay-anchor">
          <button
            type="button"
            className={`tb-btn tb-replay-entry${replay.active || replay.setupArmed ? " active" : ""}`}
            title={
              replay.active
                ? "Exit replay - back to live view"
                : replay.setupArmed
                  ? "Cancel replay setup (Esc)"
                  : "Enter Replay Mode - pick a candle or a date/time to start from"
            }
            disabled={replay.totalBars === 0}
            onClick={() => {
              if (replay.active) replay.exit();
              else if (replay.setupArmed) replay.cancelSetup();
              else replay.armSetup();
            }}
          >
            <span className="tb-glyph">⏵</span> Replay
          </button>
          {replay.setupArmed && <ReplaySetupMenu />}
        </div>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        {LAYOUT_PANE_COUNTS.map((n) => (
          <button key={n} type="button" className={`tb-btn${layout === n ? " active" : ""}`} onClick={() => applyLayout(n)}>
            {n}
          </button>
        ))}
      </div>

      {(activeToolId === "long" || activeToolId === "short") && (
        <>
          <div className="tb-sep" />
          <div className="tb-group">
            <span className="tb-rr-label">R:R</span>
            <input
              type="number"
              className="tb-select tb-rr-input"
              value={pendingRR}
              step={0.05}
              min={0.1}
              onChange={(e) => setPendingRR(parseFloat(e.target.value) || 2.45)}
              title="Risk:Reward for the Long/Short tool"
            />
          </div>
        </>
      )}

      <div className="tb-sep" />

      <div className="tb-group">
        <select
          className="tb-select"
          value={activeWorkspace}
          onChange={(e) => switchWorkspace(e.target.value)}
          title="Workspace"
        >
          {Object.keys(workspaces).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="tb-btn"
          title="Save current layout as a new workspace"
          onClick={() => {
            const name = window.prompt("Save as workspace:");
            if (name) saveAsWorkspace(name);
          }}
        >
          +
        </button>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group">
        <button type="button" className="tb-btn" title="Command palette (Ctrl/Cmd+K)" onClick={() => setCommandPaletteOpen(true)}>
          ⌕
        </button>
        <button
          type="button"
          className={`tb-btn${analysisHubOpen ? " active" : ""}`}
          title="Indicators & SMC overlays"
          onClick={() => setAnalysisHubOpen(!analysisHubOpen)}
        >
          <span className="tb-glyph">Ω</span>
        </button>
        <button
          type="button"
          className={`tb-btn${watchlistOpen ? " active" : ""}`}
          title={watchlistOpen ? "Hide docked Watchlist panel" : "Show docked Watchlist panel (also always available in the right sidebar)"}
          disabled={!dockviewApi}
          onClick={toggleWatchlist}
        >
          <span className="tb-glyph">☰</span>
        </button>
        <button
          type="button"
          className={`tb-btn${marketStructureDatasetOpen ? " active" : ""}`}
          title="Market Structure Dataset - your logged BOS/CHoCH drawings"
          onClick={() => setMarketStructureDatasetOpen(!marketStructureDatasetOpen)}
        >
          <span className="tb-glyph">M</span>
        </button>
        <button type="button" className="tb-btn" title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>
          {theme === "dark" ? "☾" : "☼"}
        </button>
        <button
          type="button"
          className={`tb-btn${settingsOpen ? " active" : ""}`}
          title="Settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <span className="tb-glyph">⚙</span>
        </button>
        <button
          type="button"
          className={`tb-btn${isFullscreen ? " active" : ""}`}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          onClick={toggleFullscreen}
        >
          <span className="tb-glyph">{isFullscreen ? "⤢" : "⛶"}</span>
        </button>
      </div>
    </div>
  );
}
