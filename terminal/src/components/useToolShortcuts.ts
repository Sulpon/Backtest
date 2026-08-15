import { useEffect } from "react";
import { TOOL_GROUPS, TOOL_SHORTCUTS } from "./toolDefinitions";
import { useUiStore } from "../workspace/uiStore";
import { PLACEMENT_HINTS } from "./LeftToolRail";

const TOOLS_BY_ID = new Map(TOOL_GROUPS.flatMap((g) => g.tools).map((t) => [t.id, t]));
const IDS_BY_SHORTCUT = new Map(Object.entries(TOOL_SHORTCUTS).map(([id, key]) => [key.toUpperCase(), id]));

/** Single global listener (mounted once, not per pane) arming a tool on its
 * letter shortcut - mirrors LeftToolRail's own pickTool logic so a shortcut
 * behaves identically to clicking the tool. */
export function useToolShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const id = IDS_BY_SHORTCUT.get(e.key.toUpperCase());
      if (!id) return;
      const tool = TOOLS_BY_ID.get(id);
      if (!tool || !tool.live) return;
      e.preventDefault();
      useUiStore.getState().setActiveTool(tool.id, PLACEMENT_HINTS[tool.id] ?? null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
