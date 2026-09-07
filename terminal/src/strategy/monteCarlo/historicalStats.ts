import type { ScanTradeRecord } from "../types";
import { computeKpis } from "../analysis/dateAnalytics";

/**
 * My Strategy mode's ONLY read of ScanTradeRecord[] - reuses
 * dateAnalytics.ts's existing computeKpis (which itself reuses
 * computeLiveStats via scanTradesToStatsInput, see that module's own doc
 * comments) for count/winRate/expectancy, so those three numbers are
 * GUARANTEED identical to what Detailed Analysis shows for the same
 * filtered trade set - never a second, possibly-diverging calculation.
 * The only thing added here is the Avg Win / Avg Loss split (not part of
 * DetailedKpis) and `rHistory`, the bootstrap population itself.
 *
 * Callers are expected to have already filtered `trades` via
 * dateAnalytics.ts's own `filterTrades` (symbols/setup/exitTime range) -
 * this function does no filtering of its own, so it can never diverge from
 * Detailed Analysis's filtering semantics.
 */
export interface HistoricalRStats {
  count: number;
  winRate: number;
  /** Mean R of winning trades (positive), 0 if there are no wins. */
  avgWinR: number;
  /** Mean |R| of losing trades (positive magnitude), 0 if there are no
   * losses. */
  avgLossR: number;
  /** Same value as dateAnalytics.ts's DetailedKpis.expectancy - reused,
   * not recomputed. */
  expectancy: number;
  /** trade.r for every trade, sorted by exitTime ascending (never
   * entryTime, per dateAnalytics.ts's global rule) - engine.ts's bootstrap
   * source samples from this array with replacement. Non-finite values
   * (NaN/Infinity - should never occur in a real ScanTradeRecord, but
   * guarded per the spec's "invalid R values" requirement) are filtered
   * out before this array is used as a sampling population, without
   * altering `count`/`winRate`/`expectancy` above (those still reflect
   * every trade). */
  rHistory: number[];
}

export function historicalRStats(trades: ScanTradeRecord[]): HistoricalRStats {
  const kpis = computeKpis(trades);
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  const wins = sorted.filter((t) => t.result === "Win");
  const losses = sorted.filter((t) => t.result === "Lose");
  const avgWinR = wins.length > 0 ? wins.reduce((sum, t) => sum + t.r, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + t.r, 0) / losses.length) : 0;

  return {
    count: kpis.total,
    winRate: kpis.winRate,
    avgWinR,
    avgLossR,
    expectancy: kpis.expectancy,
    rHistory: sorted.map((t) => t.r).filter((r) => Number.isFinite(r)),
  };
}
