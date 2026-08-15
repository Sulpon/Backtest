import { TopToolbar } from "./TopToolbar";
import { LeftToolRail } from "./LeftToolRail";
import { DockviewRoot } from "./DockviewRoot";
import { StatusBar } from "./StatusBar";
import { AnalysisHub } from "../analysis/AnalysisHub";
import { PineSettingsDialog } from "../pine/PineSettingsDialog";
import { CommandPalette } from "../commandPalette/CommandPalette";
import { useCommandPaletteHotkey } from "../commandPalette/useCommandPaletteHotkey";
import { SettingsPanel } from "../settings/SettingsPanel";
import { SettingsEffects } from "../settings/SettingsEffects";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useReplayHotkeys } from "../replay/useReplayHotkeys";
import "./AppShell.css";

export function AppShell() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace);
  useReplayHotkeys();
  useCommandPaletteHotkey();

  return (
    <div className="app-shell">
      <TopToolbar />
      <div className="app-body">
        <LeftToolRail />
        {/* keyed on workspace name so switching workspaces remounts the dock
            surface and restores that workspace's own saved layout cleanly */}
        <DockviewRoot key={activeWorkspace} />
      </div>
      <StatusBar />
      <AnalysisHub />
      <PineSettingsDialog />
      <CommandPalette />
      <SettingsPanel />
      <SettingsEffects />
    </div>
  );
}
