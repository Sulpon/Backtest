import type { Trade } from "../data/types";
import type { PineRunResult } from "./usePineIndicators";

export interface PineTradeWithSource {
  trade: Trade;
  /** The exact PineRunResult this trade came from - needed for anything
   * that must convert this trade's entryBar/exitBar to a real time (they're
   * indices into THIS result's own windowedBars, not any shared/full-
   * dataset array - see PineIndicatorLayer's barIndexToTime doc comment)
   * or inspect this indicator's own drawing output (e.g. deriving "detected
   * conditions" for a Telegram trade review from its BOS/CHoCH/FVG labels -
   * see telegram/tradeReviewPayload.ts). Lost by collectPineTrades' plain
   * Trade[] return, which is why this variant exists. */
  source: PineRunResult;
}

/** Flattens every visible Pine indicator's recorded trades into
 * {trade, source} pairs, skipping anything the user removed via the
 * chart's right-click menu, sorted by entry time across all indicators
 * together (comparing entryBar directly would be wrong once more than one
 * indicator is active, since each one's entryBar indexes its own
 * windowedBars - comparing the real bar time instead is what makes this
 * a genuine chronological merge).
 *
 * `removed` must come from a reactive `usePineTradeOverridesStore((s) =>
 * s.removed)` subscription in the caller (not `.getState()`) - this is a
 * plain function, not a hook, specifically so callers control when it
 * re-runs (inside their own useMemo) rather than this module silently
 * reading stale state. */
export function collectPineTradesWithSource(results: PineRunResult[], removed: Record<string, true>): PineTradeWithSource[] {
  if (results.length === 0) return [];
  const pairs: PineTradeWithSource[] = [];
  for (const result of results) {
    for (const t of result.outputs.trades) {
      if (removed[t.id]) continue;
      pairs.push({
        trade: {
          dir: t.dir,
          entryBar: t.entryBar,
          entryPrice: t.entryPrice,
          sl: t.sl,
          tp: t.tp,
          exitBar: t.exitBar,
          result: t.result,
          r: t.r,
          setup: t.setup,
        },
        source: result,
      });
    }
  }
  return pairs.sort((a, b) => {
    const ta = a.source.windowedBars[a.trade.entryBar]?.time ?? 0;
    const tb = b.source.windowedBars[b.trade.entryBar]?.time ?? 0;
    return ta - tb;
  });
}

/** Flattens every visible Pine indicator's recorded trades into the app's
 * own `Trade` shape (dropping the Pine-only `id`, which only exists so a
 * removed trade can be excluded here). Shared by ChartPane (pane-header
 * stats) and TradesPanel so "trades from a Pine indicator" means the same
 * thing in both places - TradesPanel's own Telegram-review buttons need
 * the source result too, so they use collectPineTradesWithSource directly
 * instead of this. */
export function collectPineTrades(results: PineRunResult[], removed: Record<string, true>): Trade[] {
  return collectPineTradesWithSource(results, removed).map((p) => p.trade);
}
