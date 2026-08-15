import { useMemo } from "react";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useUiStore } from "../workspace/uiStore";
import { useReplayStore } from "../replay/replayStore";
import { useTheme } from "../theme/ThemeProvider";
import { TOOL_GROUPS } from "../components/toolDefinitions";
import { pickTool } from "../components/LeftToolRail";
import { TIMEFRAMES, TIMEFRAME_LABELS, secondaryTimeframe } from "../data/timeframes";
import type { Timeframe } from "../data/types";

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
          if (!api || api.getPanel("chart-2")) return;
          // chart-1 owns its own symbol/timeframe (ChartPaneParams) now -
          // pair the new pane with whatever it's ACTUALLY showing, falling
          // back to the workspace default only if chart-1 doesn't exist yet.
          const chart1Params = api.getPanel("chart-1")?.params as { symbol?: string; timeframe?: Timeframe } | undefined;
          const wsState = useWorkspaceStore.getState();
          const active = wsState.workspaces[wsState.activeWorkspace];
          const symbol = chart1Params?.symbol ?? active.symbol;
          const timeframe = chart1Params?.timeframe ?? active.timeframe;
          const secondaryTf = secondaryTimeframe(timeframe);
          api.addPanel({
            id: "chart-2",
            component: "chart",
            title: `${symbol} · ${TIMEFRAME_LABELS[secondaryTf]}`,
            params: { symbol, timeframe: secondaryTf },
            position: { referencePanel: "chart-1", direction: "right" },
          });
        },
      },
      {
        id: "view:collapsePane",
        label: "View: Collapse to Single Pane",
        category: "View",
        run: () => {
          const api = useUiStore.getState().dockviewApi;
          const p2 = api?.getPanel("chart-2");
          if (p2) api!.removePanel(p2);
        },
      }
    );

    return cmds;
  }, [workspaces, toggleTheme]);
}
