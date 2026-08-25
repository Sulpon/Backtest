import { useEffect, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { useActiveWorkspace, useWorkspaceStore } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { useFocusedChartPane } from "../workspace/useFocusedChartPane";
import { useReplayStore } from "../replay/replayStore";
import { ReplaySetupMenu } from "../replay/ReplaySetupMenu";
import { TIMEFRAMES, TIMEFRAME_LABELS, secondaryTimeframe } from "../data/timeframes";
import type { Timeframe } from "../data/types";
import { useSymbols } from "../data/useSymbols";
import "./TopToolbar.css";

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
  const [layout, setLayoutLocal] = useState("1");
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

  // "2" splits into a second chart pane pinned to a different timeframe of
  // the same symbol as whichever pane is focused, both driven by the same
  // Replay Engine cursor (see ChartPane's localCursorBar) - though since
  // every pane now owns its own symbol/timeframe, either one can be
  // changed independently right after. "4" doesn't have a meaningful
  // interpretation yet - it'd need to pick 4 specific symbol/timeframe
  // combinations, which is a real design decision (which 4? user-chosen?)
  // rather than something to guess at here.
  function applyLayout(n: string) {
    setLayoutLocal(n);
    const api = dockviewApi;
    if (n === "1") {
      const p2 = api?.getPanel("chart-2");
      if (p2) api!.removePanel(p2);
      return;
    }
    if (n === "2") {
      if (!api || api.getPanel("chart-2")) return;
      const secondaryTf = secondaryTimeframe(displayTimeframe);
      api.addPanel({
        id: "chart-2",
        component: "chart",
        title: `${displaySymbol} · ${TIMEFRAME_LABELS[secondaryTf]}`,
        params: { symbol: displaySymbol, timeframe: secondaryTf },
        position: { referencePanel: "chart-1", direction: "right" },
      });
      return;
    }
    setHint("4-pane needs a specific symbol/timeframe layout picked - not wired up yet, try 2 for now");
  }

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
        {["1", "2", "4"].map((n) => (
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
          className={`tb-btn${watchlistOpen ? " active" : ""}`}
          title={watchlistOpen ? "Hide Watchlist" : "Show Watchlist"}
          disabled={!dockviewApi}
          onClick={toggleWatchlist}
        >
          <span className="tb-glyph">☰</span>
        </button>
        <button
          type="button"
          className={`tb-btn${analysisHubOpen ? " active" : ""}`}
          title="Analysis"
          onClick={() => setAnalysisHubOpen(!analysisHubOpen)}
        >
          <span className="tb-glyph">Ω</span>
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
      </div>
    </div>
  );
}
