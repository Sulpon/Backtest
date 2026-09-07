import type { MonteCarloRawResult } from "./types";

function toSortedArray(values: ArrayLike<number>): number[] {
  const arr: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  arr.sort((a, b) => a - b);
  return arr;
}

/** Linear-interpolation percentile (0-100) over a copy of `values`, sorted
 * ascending - the standard definition (`p=0` is the minimum, `p=100` the
 * maximum, `p=50` the median). Every "Nth percentile" in this module is
 * expressed through this single function, including the "worse = more
 * negative/larger" severity metrics (drawdown, losing streak) - see
 * drawdownStats/streakStats below for how each maps the spec's own
 * "Nth percentile [of severity]" language onto this ascending convention. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = toSortedArray(values);
  if (n === 1) return sorted[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export function median(values: ArrayLike<number>): number {
  return percentile(values, 50);
}

export function mean(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

/** % of values strictly greater than 0 - "probability of finishing
 * positive"/"probability positive" throughout this module's outputs. */
export function probabilityPositive(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  let count = 0;
  for (let i = 0; i < n; i++) if (values[i] > 0) count++;
  return (count / n) * 100;
}

export interface FinalRStats {
  mean: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  probabilityPositive: number;
}

export interface DrawdownStats {
  median: number;
  p75: number;
  p90: number;
  p95: number;
  /** Most negative single simulated max-drawdown observed. */
  worst: number;
}

export interface StreakStats {
  median: number;
  p75: number;
  p90: number;
  p95: number;
  /** Largest single simulated streak observed. */
  max: number;
}

/**
 * Drawdown values are always <= 0 (0 = never dipped below start), and MORE
 * NEGATIVE means worse. The spec's own examples ("Median: -56.3R, 95%:
 * -128.4R, Worst: -312.6R") show the "Nth percentile" label meaning "N% of
 * simulations were BETTER (less negative) than this" - i.e. only (100-N)%
 * were this bad or worse. Since ascending-sorted drawdowns put the most
 * negative (worst) values first, that "95th percentile of severity" is
 * percentile(values, 5) in the standard ascending sense - matching the
 * Interpretation section's own phrasing ("95% of simulations had maximum
 * drawdown better than -Y R"). `worst` is simply the minimum, i.e.
 * percentile(values, 0).
 */
export function drawdownStats(values: ArrayLike<number>): DrawdownStats {
  return {
    median: percentile(values, 50),
    p75: percentile(values, 25),
    p90: percentile(values, 10),
    p95: percentile(values, 5),
    worst: percentile(values, 0),
  };
}

/** Losing/winning streak counts are >= 0 and LARGER means more extreme -
 * the standard ascending percentile convention already matches "Nth
 * percentile" here (no inversion needed, unlike drawdownStats). `max` is
 * the maximum observed, i.e. percentile(values, 100). */
export function streakStats(values: ArrayLike<number>): StreakStats {
  return {
    median: percentile(values, 50),
    p75: percentile(values, 75),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
}

export interface AggregatedMonteCarloStats {
  finalR: FinalRStats;
  maxDrawdown: DrawdownStats;
  winningStreak: StreakStats;
  losingStreak: StreakStats;
}

/** Every "across all simulations" statistic the spec lists, computed from
 * the FULL `raw.finalR`/`maxDrawdownR`/streak arrays (all `numSimulations`
 * entries) - never from the bounded representative/retained samples, which
 * exist only for chart rendering and Risk Comparison respectively (see
 * types.ts's MonteCarloRawResult doc comment). */
export function aggregateResults(raw: MonteCarloRawResult): AggregatedMonteCarloStats {
  return {
    finalR: {
      mean: mean(raw.finalR),
      median: median(raw.finalR),
      p5: percentile(raw.finalR, 5),
      p25: percentile(raw.finalR, 25),
      p75: percentile(raw.finalR, 75),
      p95: percentile(raw.finalR, 95),
      probabilityPositive: probabilityPositive(raw.finalR),
    },
    maxDrawdown: drawdownStats(raw.maxDrawdownR),
    winningStreak: streakStats(raw.maxWinningStreak),
    losingStreak: streakStats(raw.maxLosingStreak),
  };
}

export interface EquityEnvelopePoint {
  tradeIndex: number;
  p5: number;
  median: number;
  p95: number;
}

/** The 5th/median/95th percentile equity-in-R value at each of
 * raw.checkpointTradeIndex's bounded checkpoints, across ALL simulations -
 * the "percentile envelope" the Monte Carlo Equity Curve chart draws
 * alongside its ~50-100 individual representative paths. */
export function equityEnvelope(raw: MonteCarloRawResult): EquityEnvelopePoint[] {
  return raw.checkpointTradeIndex.map((tradeIndex, row) => {
    const column = raw.checkpointEquity[row];
    return {
      tradeIndex,
      p5: percentile(column, 5),
      median: percentile(column, 50),
      p95: percentile(column, 95),
    };
  });
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/** Equal-width bins spanning [min, max] of `values` - the Final R
 * Distribution / Max Drawdown Distribution charts' only data source. A
 * single all-equal-values input collapses to one bin holding every value
 * (avoids a zero-width-bin division). */
export function histogramBins(values: ArrayLike<number>, binCount = 24): HistogramBin[] {
  const n = values.length;
  if (n === 0) return [];
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (min === max) return [{ from: min, to: max, count: n }];

  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
  }));
  for (let i = 0; i < n; i++) {
    let idx = Math.floor((values[i] - min) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  return bins;
}
