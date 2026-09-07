import type { AggregatedMonteCarloStats } from "./statistics";

function signedR(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

/**
 * Dynamic, probabilistic-language sentences for My Strategy's Interpretation
 * section - every value comes from `agg` (statistics.ts's
 * aggregateResults output for this exact run), never hardcoded, per spec's
 * explicit "Never say 'Your strategy will make X'" / "these are example
 * values only" warnings. Matches the spec's own three-sentence example
 * structure exactly (historical-trades/simulations line, median result
 * line, drawdown-percentile line).
 */
export function myStrategyInterpretation(historicalCount: number, numSimulations: number, agg: AggregatedMonteCarloStats): string[] {
  return [
    `Based on ${historicalCount.toLocaleString()} historical trades, ${numSimulations.toLocaleString()} simulated sequences were generated using bootstrap resampling of the historical R distribution.`,
    `The median simulated result after ${historicalCount.toLocaleString()} trades was ${signedR(agg.finalR.median)}.`,
    `95% of simulations had maximum drawdown better than ${signedR(agg.maxDrawdown.p95)}.`,
  ];
}

/** Strategy Lab's Interpretation section - the theoretical expectancy
 * sentence from the spec's own example, built from the user's current
 * inputs (never a simulated result - Strategy Lab's theoretical metrics
 * are shown before "Run Simulation" is ever pressed, see labMath.ts). */
export function strategyLabInterpretation(winRatePct: number, avgWinR: number, avgLossR: number, expectedValueR: number): string[] {
  return [
    `With a ${winRatePct.toFixed(0)}% win rate, ${signedR(avgWinR, 2)} average win and ${signedR(-avgLossR, 2)} average loss, the theoretical expectancy is ${signedR(expectedValueR, 2)} per trade.`,
  ];
}
