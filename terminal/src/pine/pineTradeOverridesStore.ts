import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Pine-detected trades (see interpreter.ts's PineTradeRecord /
 * backtest.recordTrade) are pure recomputed output - re-running the script
 * always regenerates the same trade, there's nowhere to "delete" it from.
 * Removing one via the chart's right-click menu instead records a
 * client-side exclusion here, keyed by a composite, indicator-scoped id
 * (see pineTradesAdapter.ts's pineTradeCompositeId - `${indicatorId}:
 * ${entry+exit bar}`, never the trade's raw id alone, since two different
 * indicators can produce the same entry+exit bar for unrelated trades), so
 * it stays hidden across future re-runs of the same script without ever
 * hiding another indicator's same-shaped trade - mirroring how
 * journalStore keeps notes independent of the (also regenerated) backtest
 * engine output.
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
