import type { Trade } from "../data/types";
import type { PineRunResult } from "./usePineIndicators";

/** Flattens every visible Pine indicator's recorded trades into the app's
 * own `Trade` shape (dropping the Pine-only `id`, which only exists so a
 * removed trade can be excluded here), skipping anything the user removed
 * via the chart's right-click menu. Shared by ChartPane (pane-header
 * stats) and TradesPanel so "trades from a Pine indicator" means the same
 * thing in both places.
 *
 * `removed` must come from a reactive `usePineTradeOverridesStore((s) =>
 * s.removed)` subscription in the caller (not `.getState()`) - this is a
 * plain function, not a hook, specifically so callers control when it
 * re-runs (inside their own useMemo) rather than this module silently
 * reading stale state. */
export function collectPineTrades(results: PineRunResult[], removed: Record<string, true>): Trade[] {
  if (results.length === 0) return [];
  const trades: Trade[] = [];
  for (const result of results) {
    for (const t of result.outputs.trades) {
      if (removed[t.id]) continue;
      trades.push({
        dir: t.dir,
        entryBar: t.entryBar,
        entryPrice: t.entryPrice,
        sl: t.sl,
        tp: t.tp,
        exitBar: t.exitBar,
        result: t.result,
        r: t.r,
        setup: t.setup,
      });
    }
  }
  return trades.sort((a, b) => a.entryBar - b.entryBar);
}
