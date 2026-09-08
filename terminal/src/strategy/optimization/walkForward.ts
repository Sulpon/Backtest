import type { ScanTradeRecord } from "../types";
import { computeCandidateMetrics } from "./metrics";
import type { DateRange, ParameterCombination, WalkForwardFoldConfig, WalkForwardFoldResult, WalkForwardSummary } from "./types";

/**
 * Chronological (anchored/expanding) Walk-Forward Validation - pure, no
 * Pine/RNG involvement. Reuses each parameter combination's already-
 * generated full-range trade set (see strategyEvaluation.ts - trades are
 * generated ONCE per combination across the whole configured date range,
 * never re-generated per fold) and slices it into each fold's train/test
 * windows purely by exitTime, exactly like trainTestSplit.ts's single-
 * split boundary. No future leakage is possible by construction: a fold's
 * train window never extends past its own test window's start, and a
 * fold's test window never extends past that fold's own end.
 *
 * With F folds, the range is divided into F+1 equal-width windows
 * W0..WF. Fold k (0-indexed) trains on [start, end of Wk] (an ANCHORED,
 * expanding window - every earlier window plus its own) and tests on
 * Wk+1 alone - the standard walk-forward shape, and the reason a single
 * fold (F=1) reduces to exactly a 50/50 train/test split.
 */
export function generateWalkForwardFolds(range: DateRange, folds: number): WalkForwardFoldConfig[] {
  if (folds < 1) throw new Error(`Walk-forward requires at least 1 fold (got ${folds}).`);

  const totalSpan = range.toSec - range.fromSec;
  const windowSpan = totalSpan / (folds + 1);
  const boundaries = Array.from({ length: folds + 2 }, (_, i) => range.fromSec + i * windowSpan);
  boundaries[folds + 1] = range.toSec; // force exact end, avoiding float drift from repeated addition

  return Array.from({ length: folds }, (_, i) => ({
    trainRange: { fromSec: range.fromSec, toSec: boundaries[i + 1] },
    testRange: { fromSec: boundaries[i + 1], toSec: boundaries[i + 2] },
  }));
}

export interface WalkForwardInput {
  combos: ParameterCombination[];
  /** Each combination's full trade set across the ENTIRE configured date
   * range, generated once (see strategyEvaluation.ts) - this function only
   * ever filters these by exitTime, never regenerates or re-invokes Pine. */
  tradesByCombo: Map<string, ScanTradeRecord[]>;
  range: DateRange;
  folds: number;
  minSampleSize: number;
  /** The training-only score used to pick a fold's "winning" parameter
   * combination - e.g. `(trades) => computeCandidateMetrics(trades).totalR`.
   * Deliberately injected rather than hardcoded so this stays consistent
   * with whatever objective the caller's main grid search uses. */
  selectionScoreOf: (trades: ScanTradeRecord[]) => number;
}

function tradesInRange(trades: ScanTradeRecord[], range: DateRange): ScanTradeRecord[] {
  return trades.filter((t) => t.exitTime >= range.fromSec && t.exitTime <= range.toSec);
}

/**
 * Runs every fold's own train-only parameter selection (never picking a
 * combination using its test-window trades) and evaluates the winner on
 * that fold's unseen test window. The OOS (out-of-sample) summary
 * aggregates every fold's own test-period trades - a realistic
 * "performance as actually experienced walking forward through time,
 * re-selecting parameters at each step" curve, not a single fixed
 * parameter set's full-range result.
 */
export function runWalkForward(input: WalkForwardInput): WalkForwardSummary {
  const { combos, tradesByCombo, range, folds, minSampleSize, selectionScoreOf } = input;
  if (combos.length === 0) throw new Error("Walk-forward requires at least one parameter combination.");

  const foldConfigs = generateWalkForwardFolds(range, folds);
  const foldResults: WalkForwardFoldResult[] = [];
  const allOosTestTrades: ScanTradeRecord[] = [];

  foldConfigs.forEach((fc, foldIndex) => {
    let bestCombo = combos[0];
    let bestScore = -Infinity;
    for (const combo of combos) {
      const trainTrades = tradesInRange(tradesByCombo.get(combo.key) ?? [], fc.trainRange);
      const score = selectionScoreOf(trainTrades);
      if (score > bestScore) {
        bestScore = score;
        bestCombo = combo;
      }
    }

    const comboTrades = tradesByCombo.get(bestCombo.key) ?? [];
    const trainTrades = tradesInRange(comboTrades, fc.trainRange);
    const testTrades = comboTrades.filter((t) => t.exitTime > fc.testRange.fromSec && t.exitTime <= fc.testRange.toSec);
    allOosTestTrades.push(...testTrades);

    foldResults.push({
      foldIndex,
      trainRange: fc.trainRange,
      testRange: fc.testRange,
      selectedParams: bestCombo.values,
      trainMetrics: computeCandidateMetrics(trainTrades, minSampleSize),
      testMetrics: computeCandidateMetrics(testTrades, minSampleSize),
    });
  });

  const oosMetrics = computeCandidateMetrics(allOosTestTrades, minSampleSize);
  const profitableFolds = foldResults.filter((f) => f.testMetrics.totalR > 0).length;

  return {
    folds: foldResults,
    oosTotalR: oosMetrics.totalR,
    oosExpectedValue: oosMetrics.expectedValue,
    oosWinRate: oosMetrics.winRate,
    oosMaxDrawdownR: oosMetrics.maxDrawdownR,
    profitableFolds,
    totalFolds: foldResults.length,
    oosConsistencyPct: foldResults.length === 0 ? 0 : (profitableFolds / foldResults.length) * 100,
  };
}
