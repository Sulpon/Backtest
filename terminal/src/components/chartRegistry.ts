import { create } from "zustand";
import type { Timeframe } from "../data/types";

export interface ChartSnapshotWindow {
  fromTime: number; // unix seconds
  toTime: number;
  /** Optional - when provided, the snapshot draws this exact trade's
   * entry/SL/TP as a dedicated risk/reward zone (red toward SL, green
   * toward TP) plus "Fib 1/0.71/0" labels and a centered BOS/CHoCH label,
   * spanning exactly [entryTime, exitTime] - the trade's own real
   * duration, not the wider snapshot window - drawn on its own canvas
   * layer (see ChartPane.tsx's drawTradeAnnotations) so its exact pixel
   * position is fully controlled rather than depending on the native
   * chart's auto-scaled price range. Independent of the live platform's
   * own Trade Zones toggle. */
  reviewedTrade?: {
    entryPrice: number;
    sl: number;
    tp: number;
    entryTime: number; // unix seconds
    exitTime: number;
    setup: "BOS" | "CHoCH" | null;
  };
}

export interface RegisteredChart {
  symbol: string;
  timeframe: Timeframe;
  takeSnapshot: (window: ChartSnapshotWindow) => Promise<string>; // resolves to a PNG data URL
}

interface ChartRegistryStore {
  panes: Record<string, RegisteredChart>;
  register: (paneId: string, entry: RegisteredChart) => void;
  unregister: (paneId: string) => void;
}

/** Lets a non-chart component (e.g. the trade journal's "Send to Telegram"
 * button) ask "is there a mounted chart pane currently showing symbol X on
 * timeframe Y, and can I get a snapshot from it?" without prop-drilling
 * through dockview's panel API - same registration-store pattern already
 * used by replayStore/analysisStore for cross-component chart state. Each
 * ChartPane instance registers/unregisters itself under its own dockview
 * panel id as its symbol/timeframe/data change - see ChartPane.tsx. */
export const useChartRegistry = create<ChartRegistryStore>((set) => ({
  panes: {},
  register: (paneId, entry) => set((s) => ({ panes: { ...s.panes, [paneId]: entry } })),
  unregister: (paneId) =>
    set((s) => {
      const next = { ...s.panes };
      delete next[paneId];
      return { panes: next };
    }),
}));

export function findChartForSymbol(
  panes: Record<string, RegisteredChart>,
  symbol: string,
  timeframe: Timeframe
): RegisteredChart | null {
  return Object.values(panes).find((p) => p.symbol === symbol && p.timeframe === timeframe) ?? null;
}
