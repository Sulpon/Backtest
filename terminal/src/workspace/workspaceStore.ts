import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Timeframe } from "../data/types";
import type { ThemeName } from "../theme/ThemeProvider";

/**
 * A workspace bundles everything Section 08 of the architecture doc lists:
 * panel layout, active symbol/timeframe, theme, and (later) pinned tools and
 * hotkey overrides. Seven named presets ship out of the box - Trading,
 * Replay, Research, Review, Journal, Development, Custom - each seeding a
 * different default panel layout (see DockviewRoot's seedLayout) the first
 * time it's opened. `preset` records which seed to use; a workspace created
 * via "+" (saveAsWorkspace) is a copy of the current one, dockLayout and
 * all, so it never needs a seed of its own.
 */
export type WorkspacePreset = "Trading" | "Replay" | "Research" | "Review" | "Journal" | "Development" | "Custom";

const WORKSPACE_PRESETS: WorkspacePreset[] = ["Trading", "Replay", "Research", "Review", "Journal", "Development", "Custom"];

export interface WorkspaceState {
  name: string;
  preset?: WorkspacePreset;
  dockLayout: unknown | null; // Dockview's serialized layout (SerializedDockview), opaque here
  symbol: string;
  timeframe: Timeframe;
  theme: ThemeName;
  pinnedTools: string[];
}

interface WorkspaceStore {
  workspaces: Record<string, WorkspaceState>;
  activeWorkspace: string;

  setSymbol: (symbol: string) => void;
  setTimeframe: (tf: Timeframe) => void;
  saveDockLayout: (layout: unknown) => void;
  switchWorkspace: (name: string) => void;
  saveAsWorkspace: (name: string) => void;
}

function defaultWorkspace(name: string, preset?: WorkspacePreset): WorkspaceState {
  return {
    name,
    preset,
    dockLayout: null,
    symbol: "EURUSD",
    timeframe: "1h",
    theme: "dark",
    pinnedTools: ["cursor", "trendline", "hline", "long", "short"],
  };
}

function defaultWorkspaces(): Record<string, WorkspaceState> {
  return Object.fromEntries(WORKSPACE_PRESETS.map((p) => [p, defaultWorkspace(p, p)]));
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      workspaces: defaultWorkspaces(),
      activeWorkspace: "Trading",

      setSymbol: (symbol) =>
        set((s) => ({
          workspaces: {
            ...s.workspaces,
            [s.activeWorkspace]: { ...s.workspaces[s.activeWorkspace], symbol },
          },
        })),

      setTimeframe: (timeframe) =>
        set((s) => ({
          workspaces: {
            ...s.workspaces,
            [s.activeWorkspace]: { ...s.workspaces[s.activeWorkspace], timeframe },
          },
        })),

      saveDockLayout: (dockLayout) =>
        set((s) => ({
          workspaces: {
            ...s.workspaces,
            [s.activeWorkspace]: { ...s.workspaces[s.activeWorkspace], dockLayout },
          },
        })),

      switchWorkspace: (name) => {
        const ws = get().workspaces[name];
        if (!ws) return;
        set({ activeWorkspace: name });
      },

      saveAsWorkspace: (name) => {
        const current = get().workspaces[get().activeWorkspace];
        set((s) => ({
          workspaces: { ...s.workspaces, [name]: { ...current, name, preset: undefined } },
          activeWorkspace: name,
        }));
      },
    }),
    {
      name: "terminal.workspaces",
      // union persisted workspaces over fresh defaults, so a returning user
      // keeps their saved layouts/custom workspaces AND picks up any preset
      // this build added that their storage predates - never drops either side.
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceStore> | undefined;
        const workspaces = { ...current.workspaces, ...(p?.workspaces ?? {}) };
        return {
          ...current,
          ...p,
          workspaces,
          activeWorkspace: p?.activeWorkspace && workspaces[p.activeWorkspace] ? p.activeWorkspace : current.activeWorkspace,
        };
      },
    }
  )
);

export function useActiveWorkspace(): WorkspaceState {
  return useWorkspaceStore((s) => s.workspaces[s.activeWorkspace]);
}
