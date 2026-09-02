import { useMemo } from "react";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { useReplayStore } from "../replay/replayStore";
import { useTheme } from "../theme/ThemeProvider";
import { TOOL_GROUPS } from "../components/toolDefinitions";
import { pickTool } from "../components/LeftToolRail";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../data/timeframes";
import type { Timeframe } from "../data/types";
import { applyChartLayout } from "../components/chartLayout";

export interface Command {
  id: string;
  label: string;
  category: string;
  hint?: string;
  run: () => void;
}

/** Builds the full command list fresh on every open - cheap (a few dozen
 * entries), and it means a workspace added via "+" or a store change since
 * the palette was last opened always shows up without any invalidation
 * logic. Zustand actions are called via getState() (no subscription needed,
 * these are one-shot); theme is the one exception since it's React context,
 * not a store, so it needs the hook. */
export function useCommands(): Command[] {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const { toggleTheme } = useTheme();

  return useMemo(() => {
    const cmds: Command[] = [];

    for (const name of Object.keys(workspaces)) {
      cmds.push({
        id: `workspace:${name}`,
        label: `Switch Workspace: ${name}`,
        category: "Workspace",
        run: () => useWorkspaceStore.getState().switchWorkspace(name),
      });
    }
    cmds.push({
      id: "workspace:saveAs",
      label: "Save Current Layout as New Workspace…",
      category: "Workspace",
      run: () => {
        const name = window.prompt("Save as workspace:");
        if (name) useWorkspaceStore.getState().saveAsWorkspace(name);
      },
    });

    for (const tf of TIMEFRAMES) {
      cmds.push({
        id: `tf:${tf}`,
        label: `Set Timeframe: ${TIMEFRAME_LABELS[tf]}`,
        category: "Symbol",
        run: () => useWorkspaceStore.getState().setTimeframe(tf),
      });
    }

    for (const group of TOOL_GROUPS) {
      for (const tool of group.tools) {
        cmds.push({
          id: `tool:${tool.id}`,
          label: `Tool: ${tool.label}`,
          category: "Tools",
          hint: tool.live ? undefined : "Not yet wired",
          run: () => pickTool(tool, useUiStore.getState().setActiveTool),
        });
      }
    }

    cmds.push(
      { id: "replay:setup", label: "Replay: Start Setup…", category: "Replay", run: () => useReplayStore.getState().armSetup() },
      { id: "replay:first", label: "Replay: First Bar", category: "Replay", run: () => useReplayStore.getState().first() },
      { id: "replay:last", label: "Replay: Latest Bar", category: "Replay", run: () => useReplayStore.getState().last() },
      { id: "replay:prevBar", label: "Replay: Previous Bar", category: "Replay", run: () => useReplayStore.getState().stepBackward() },
      { id: "replay:toggle", label: "Replay: Play / Pause", category: "Replay", run: () => useReplayStore.getState().toggle() },
      { id: "replay:nextBar", label: "Replay: Next Bar", category: "Replay", run: () => useReplayStore.getState().stepForward() },
      { id: "replay:prevTrade", label: "Replay: Previous Trade", category: "Replay", run: () => useReplayStore.getState().prevTrade() },
      { id: "replay:nextTrade", label: "Replay: Next Trade", category: "Replay", run: () => useReplayStore.getState().nextTrade() },
      { id: "replay:prevSession", label: "Replay: Previous Session Open", category: "Replay", run: () => useReplayStore.getState().prevSession() },
      { id: "replay:nextSession", label: "Replay: Next Session Open", category: "Replay", run: () => useReplayStore.getState().nextSession() },
      { id: "replay:exit", label: "Replay: Exit to Live", category: "Replay", run: () => useReplayStore.getState().exit() },
      {
        id: "replay:jumpToDate",
        label: "Replay: Jump to Date…",
        category: "Replay",
        run: () => {
          const input = window.prompt("Jump to date (YYYY-MM-DD):");
          if (!input) return;
          const ms = Date.parse(input + "T00:00:00Z");
          if (!Number.isNaN(ms)) useReplayStore.getState().seekToDate(ms);
        },
      }
    );

    cmds.push(
      { id: "view:theme", label: "Toggle Theme", category: "View", run: toggleTheme },
      { id: "view:analysis", label: "Open Analysis Hub", category: "View", run: () => useUiStore.getState().setAnalysisHubOpen(true) },
      { id: "view:settings", label: "Open Settings", category: "View", run: () => useUiStore.getState().setSettingsOpen(true) },
      {
        id: "view:splitPane",
        label: "View: Split Timeframe Panes",
        category: "View",
        run: () => {
          const api = useUiStore.getState().dockviewApi;
          if (!api) return;
          // chart-1 owns its own symbol/timeframe (ChartPaneParams) now -
          // pair the new pane with whatever it's ACTUALLY showing, falling
          // back to the workspace default only if chart-1 doesn't exist yet.
          // Routed through applyChartLayout (same helper the top toolbar's
          // 1/2/4/8/16 picker uses) so this always lands on a contiguous
          // chart-1/chart-2 pair rather than duplicating that bookkeeping.
          const chart1Params = api.getPanel("chart-1")?.params as { symbol?: string; timeframe?: Timeframe } | undefined;
          const wsState = useWorkspaceStore.getState();
          const active = wsState.workspaces[wsState.activeWorkspace];
          const symbol = chart1Params?.symbol ?? active.symbol;
          const timeframe = chart1Params?.timeframe ?? active.timeframe;
          applyChartLayout(api, 2, symbol, timeframe);
        },
      },
      {
        id: "view:collapsePane",
        label: "View: Collapse to Single Pane",
        category: "View",
        run: () => {
          const api = useUiStore.getState().dockviewApi;
          if (!api) return;
          // Collapses back to chart-1 regardless of how many panes are
          // currently open (not just chart-2) - see applyChartLayout.
          const wsState = useWorkspaceStore.getState();
          const active = wsState.workspaces[wsState.activeWorkspace];
          applyChartLayout(api, 1, active.symbol, active.timeframe);
        },
      }
    );

    return cmds;
  }, [workspaces, toggleTheme]);
}
