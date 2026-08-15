import { useCallback, useEffect, useRef } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./DockviewRoot.css";
import { ChartPane, type ChartPaneParams } from "./ChartPane";
import { WatchlistPanel } from "./panels/WatchlistPanel";
import { TradesPanel } from "./panels/TradesPanel";
import { StatsPanel } from "./panels/StatsPanel";
import { useWorkspaceStore, useActiveWorkspace, type WorkspaceState } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { TIMEFRAME_LABELS } from "../data/timeframes";

// Panel content components, keyed by id and looked up by dockview at render
// time. chart forwards its dockview props through so each pane gets its own
// symbol/timeframe params - everything else ignores props.
const components: Record<string, React.FC<IDockviewPanelProps>> = {
  chart: (props) => <ChartPane {...(props as IDockviewPanelProps<ChartPaneParams>)} />,
  watchlist: () => <WatchlistPanel />,
  trades: () => <TradesPanel />,
  stats: () => <StatsPanel />,
};

// Each named preset seeds a different starting layout the first time its
// workspace is opened (no saved dockLayout yet) - this is what makes the
// presets actually differ from one another, not just their name. The title
// here is only the INITIAL one - ChartPane immediately overwrites it via
// its own setTitle effect once mounted, keeping it in sync with whatever
// symbol/timeframe the pane actually ends up showing.
function seedLayout(api: DockviewApi, ws: WorkspaceState) {
  const chartTitle = `${ws.symbol} · ${TIMEFRAME_LABELS[ws.timeframe]}`;
  api.addPanel({ id: "chart-1", component: "chart", title: chartTitle, params: { symbol: ws.symbol, timeframe: ws.timeframe } });
  switch (ws.preset) {
    case "Trading":
      api.addPanel({
        id: "watchlist-1",
        component: "watchlist",
        title: "Watchlist",
        position: { referencePanel: "chart-1", direction: "right" },
        initialWidth: 260,
      });
      break;
    case "Replay":
    case "Review":
      api.addPanel({
        id: "trades-1",
        component: "trades",
        title: "Trades",
        position: { referencePanel: "chart-1", direction: "right" },
        initialWidth: 320,
      });
      break;
    case "Research":
      api.addPanel({
        id: "stats-1",
        component: "stats",
        title: "Performance",
        position: { referencePanel: "chart-1", direction: "right" },
        initialWidth: 320,
      });
      break;
    case "Journal":
      api.addPanel({
        id: "trades-1",
        component: "trades",
        title: "Trade Journal",
        position: { referencePanel: "chart-1", direction: "below" },
        initialHeight: 240,
      });
      break;
    case "Development":
    case "Custom":
    default:
      break;
  }
}

export function DockviewRoot() {
  const apiRef = useRef<DockviewReadyEvent["api"] | null>(null);
  const saveDockLayout = useWorkspaceStore((s) => s.saveDockLayout);
  const setDockviewApi = useUiStore((s) => s.setDockviewApi);
  const ws = useActiveWorkspace();

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setDockviewApi(event.api);

      const restored = ws.dockLayout;
      if (restored) {
        try {
          event.api.fromJSON(restored as Parameters<typeof event.api.fromJSON>[0]);
        } catch {
          seedLayout(event.api, ws);
        }
      } else {
        seedLayout(event.api, ws);
      }

      event.api.onDidLayoutChange(() => {
        saveDockLayout(event.api.toJSON());
      });
    },
    // deliberately only on mount - switching workspaces re-mounts DockviewRoot via key=
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    return () => setDockviewApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dock-wrap">
      <DockviewReact className="dockview-theme-abyss terminal-dock" components={components} onReady={onReady} />
    </div>
  );
}
