import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Pine-detected trades (see interpreter.ts's PineTradeRecord /
 * backtest.recordTrade) are pure recomputed output - re-running the script
 * always regenerates the same trade, there's nowhere to "delete" it from.
 * Removing one via the chart's right-click menu instead records a
 * client-side exclusion here, keyed by the trade's own deterministic id
 * (entry+exit bar), so it stays hidden across future re-runs of the same
 * script - mirroring how journalStore keeps notes independent of the
 * (also regenerated) backtest engine output.
 */
interface PineTradeOverridesStore {
  removed: Record<string, true>;
  remove: (tradeId: string) => void;
  restore: (tradeId: string) => void;
  restoreAll: () => void;
}

export const usePineTradeOverridesStore = create<PineTradeOverridesStore>()(
  persist(
    (set) => ({
      removed: {},
      remove: (tradeId) => set((s) => ({ removed: { ...s.removed, [tradeId]: true } })),
      restore: (tradeId) =>
        set((s) => {
          const { [tradeId]: _dropped, ...rest } = s.removed;
          return { removed: rest };
        }),
      restoreAll: () => set({ removed: {} }),
    }),
    { name: "terminal.pineTradeOverrides" }
  )
);
