import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

/**
 * Session-only UI state that should never survive a reload or get bundled
 * into a saved workspace: the currently armed drawing tool, its R:R input
 * (for Long/Short), and a short-lived status hint shown in the status bar.
 */
interface UiStore {
  activeToolId: string;
  statusHint: string | null;
  pendingRR: number;
  /** TradingView-style "strong" magnet: while on, every drawing point snaps
   * to the nearest OHLC level of whichever candle is under the cursor, not
   * just the nearest bar's timestamp (DrawingLayer always does that part).
   * Lives here rather than a persisted store deliberately - see LeftToolRail
   * for the toggle button. */
  magnetEnabled: boolean;
  /** "Stay active" pin (rail section 33): when on, finishing a drawing
   * re-arms the same tool instead of snapping back to the cursor, so
   * placing several trend lines in a row doesn't need re-picking the tool
   * each time. Session-only, same reasoning as activeToolId itself. */
  toolLocked: boolean;
  analysisHubOpen: boolean;
  /** Set by double-clicking a line/box/label a Pine indicator drew (see
   * PineIndicatorLayer) - tells the Analysis hub's Pine tab to open
   * straight to that indicator's editor instead of wherever the user last
   * left it. Consumed once (cleared right after) so it never re-fires. */
  pineEditTarget: string | null;
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  /** The active workspace's live Dockview API, so TopToolbar (a sibling of
   * DockviewRoot, not a parent/child) can drive layout actions like the
   * multi-timeframe split without threading a ref through AppShell. Never
   * persisted - it's a class instance, not serializable, and is re-set by
   * DockviewRoot's onReady every time the dock surface (re)mounts. */
  dockviewApi: DockviewApi | null;
  setActiveTool: (toolId: string, hint?: string | null) => void;
  setStatusHint: (hint: string | null) => void;
  setPendingRR: (rr: number) => void;
  toggleMagnet: () => void;
  toggleToolLock: () => void;
  setAnalysisHubOpen: (open: boolean) => void;
  setPineEditTarget: (id: string | null) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setDockviewApi: (api: DockviewApi | null) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  activeToolId: "cursor",
  statusHint: null,
  pendingRR: 2.45,
  magnetEnabled: false,
  toolLocked: false,
  analysisHubOpen: false,
  pineEditTarget: null,
  commandPaletteOpen: false,
  settingsOpen: false,
  dockviewApi: null,
  setActiveTool: (activeToolId, hint = null) => set({ activeToolId, statusHint: hint }),
  setStatusHint: (statusHint) => set({ statusHint }),
  setPendingRR: (pendingRR) => set({ pendingRR }),
  toggleMagnet: () => set((s) => ({ magnetEnabled: !s.magnetEnabled })),
  toggleToolLock: () => set((s) => ({ toolLocked: !s.toolLocked })),
  setAnalysisHubOpen: (analysisHubOpen) => set({ analysisHubOpen }),
  setPineEditTarget: (pineEditTarget) => set({ pineEditTarget }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setDockviewApi: (dockviewApi) => set({ dockviewApi }),
}));
