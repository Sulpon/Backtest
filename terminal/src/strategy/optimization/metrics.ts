import type { ScanTradeRecord } from "../types";
import { computeKpis, maximumDrawdown, maximumLosingStreak, maximumWinningStreak, tradeFrequencyAnalytics } from "../analysis/dateAnalytics";
import type { CandidateMetrics } from "./types";

/** Default per spec item 9 ("configurable minimum sample size (default
 * 30)"). Below this trade count a candidate is marked insufficientSample -
 * see optimizationEngine.ts, which excludes such candidates from ranking
 * rather than scoring them (a small sample must never look artificially
 * strong just because it has fewer trades to average over). */
export const DEFAULT_MIN_SAMPLE_SIZE = 30;

/**
 * Per-candidate metrics from a flat ScanTradeRecord[] - deliberately built
 * entirely on top of strategy/analysis/dateAnalytics.ts's existing
 * exitTime-based aggregation (computeKpis, maximumDrawdown/Winning/
 * LosingStreak, tradeFrequencyAnalytics), per spec's "all date-based
 * analytics must use exitTime only, reusing Detailed Analysis's
 * dateAnalytics.ts" - this file adds only profitFactor and the
 * insufficientSample flag, which dateAnalytics.ts has no reason to know
 * about (it's optimization-specific).
 */
export function computeCandidateMetrics(trades: ScanTradeRecord[], minSampleSize: number = DEFAULT_MIN_SAMPLE_SIZE): CandidateMetrics {
  const kpis = computeKpis(trades);
  const losses = kpis.total - kpis.wins;

  let winSum = 0;
  let lossSum = 0;
  for (const t of trades) {
    if (t.result === "Win") winSum += t.r;
    else lossSum += t.r;
  }
  const profitFactor = lossSum === 0 ? null : winSum / Math.abs(lossSum);

  const freq = tradeFrequencyAnalytics(trades);

  return {
    trades: kpis.total,
    wins: kpis.wins,
    losses,
    winRate: kpis.winRate,
    totalR: kpis.totalRR,
    avgTradeR: kpis.avgRR,
    expectedValue: kpis.expectancy,
    profitFactor,
    maxDrawdownR: maximumDrawdown(trades),
    maxWinningStreak: maximumWinningStreak(trades),
    maxLosingStreak: maximumLosingStreak(trades),
    avgTradesPerDay: freq.avgTradesPerDay,
    avgTradesPerWeek: freq.avgTradesPerWeek,
    avgTradesPerMonth: freq.avgTradesPerMonth,
    avgTradesPerYear: freq.avgTradesPerYear,
    bestDay: kpis.bestDay,
    worstDay: kpis.worstDay,
    insufficientSample: kpis.total < minSampleSize,
  };
}
