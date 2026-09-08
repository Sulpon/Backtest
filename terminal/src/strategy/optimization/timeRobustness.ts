import type { ScanTradeRecord } from "../types";
import { exitDateParts } from "../analysis/dateAnalytics";
import { computeCandidateMetrics } from "./metrics";
import type { TimeBreakdownRow, TimeRobustnessResult } from "./types";

/** A single year contributing at least this share of the |total R| across
 * all years is flagged as "concentrated" - a documented, fixed threshold
 * rather than a tunable, since it only feeds a warning label (see
 * overfitWarnings.ts), never a scoring cutoff. Absolute-value ratio so an
 * offsetting scenario (one strong year propping up otherwise-flat/losing
 * years) is correctly flagged too, not just a dominant positive year. */
const CONCENTRATION_THRESHOLD = 0.7;

function bucketByKey<K>(trades: ScanTradeRecord[], keyFn: (t: ScanTradeRecord) => K): Map<K, ScanTradeRecord[]> {
  const map = new Map<K, ScanTradeRecord[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const bucket = map.get(k);
    if (bucket) bucket.push(t);
    else map.set(k, [t]);
  }
  return map;
}

function rowFor(key: string, trades: ScanTradeRecord[]): TimeBreakdownRow {
  // Reuses metrics.ts (itself built on dateAnalytics.ts's exitTime-only
  // rule) rather than re-deriving totalR/winRate/EV/drawdown a second time
  // - minSampleSize is irrelevant here (this row never reads
  // insufficientSample), so 0 is passed to avoid a misleading flag.
  const m = computeCandidateMetrics(trades, 0);
  return { key, trades: m.trades, winRate: m.winRate, expectedValue: m.expectedValue, totalR: m.totalR, maxDrawdownR: m.maxDrawdownR };
}

/**
 * Year/month breakdown - buckets trades via exitDateParts (the single
 * sanctioned exitTime-bucketing function, per dateAnalytics.ts's global
 * rule), then reuses computeCandidateMetrics per bucket rather than
 * re-deriving totalR/winRate/EV/drawdown.
 */
export function computeTimeRobustness(trades: ScanTradeRecord[]): TimeRobustnessResult {
  const byYearMap = bucketByKey(trades, (t) => exitDateParts(t).year);
  const byMonthMap = bucketByKey(trades, (t) => exitDateParts(t).monthKey);

  const byYear = [...byYearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, ts]) => rowFor(String(year), ts));
  const byMonth = [...byMonthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, ts]) => rowFor(monthKey, ts));

  const totalR = trades.reduce((sum, t) => sum + t.r, 0);
  const concentratedInOneYear =
    byYear.length > 1 && totalR !== 0 && byYear.some((y) => Math.abs(y.totalR) / Math.abs(totalR) >= CONCENTRATION_THRESHOLD);

  return { byYear, byMonth, concentratedInOneYear };
}
