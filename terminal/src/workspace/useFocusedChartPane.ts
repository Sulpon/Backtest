import { useEffect, useState } from "react";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { Timeframe } from "../data/types";

interface FocusedChartPane {
  /** null when no chart pane is focused (a non-chart panel is active, or
   * there's no dock surface yet) - callers fall back to the workspace
   * default in that case. */
  panelApi: DockviewPanelApi | null;
  symbol: string | undefined;
  timeframe: Timeframe | undefined;
}

/**
 * Tracks whichever chart pane currently has dockview focus, and that pane's
 * own symbol/timeframe - the seam that lets TopToolbar's symbol/timeframe
 * controls act on "the chart the user is looking at" now that every pane
 * owns its symbol/timeframe independently (see ChartPaneParams), rather
 * than a single workspace-wide value with no specific pane to apply to.
 */
export function useFocusedChartPane(dockviewApi: DockviewApi | null): FocusedChartPane {
  const [panelApi, setPanelApi] = useState<DockviewPanelApi | null>(null);
  const [params, setParams] = useState<{ symbol?: string; timeframe?: Timeframe }>({});

  useEffect(() => {
    if (!dockviewApi) {
      setPanelApi(null);
      setParams({});
      return;
    }
    function syncFromActive() {
      const active = dockviewApi!.activePanel;
      if (active && active.api.component === "chart") {
        setPanelApi(active.api);
        setParams(active.params ?? {});
      } else {
        setPanelApi(null);
        setParams({});
      }
    }
    syncFromActive();
    const disposable = dockviewApi.onDidActivePanelChange(syncFromActive);
    return () => disposable.dispose();
  }, [dockviewApi]);

  useEffect(() => {
    if (!panelApi) return;
    const disposable = panelApi.onDidParametersChange((p) => setParams(p));
    return () => disposable.dispose();
  }, [panelApi]);

  return { panelApi, symbol: params.symbol, timeframe: params.timeframe };
}
