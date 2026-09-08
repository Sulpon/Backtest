import type { ScanTradeRecord } from "../types";
import { computeCandidateMetrics } from "./metrics";
import { splitTrainTest, computeDegradationPct } from "./trainTestSplit";
import { computeSymbolRobustness } from "./symbolRobustness";
import { computeTimeRobustness } from "./timeRobustness";
import { computeStability, findRobustRegion } from "./stability";
import { computeRobustnessScore } from "./robustness";
import { generateOverfitWarnings } from "./overfitWarnings";
import { runWalkForward } from "./walkForward";
import type {
  CandidateResult,
  DateRange,
  OptimizationObjective,
  OptimizationRunSummary,
  ParameterCombination,
  ParameterDef,
  TrainTestSplitConfig,
} from "./types";

/**
 * The pure orchestrator: given every parameter combination's already-
 * generated full-range trade set (see strategyEvaluation.ts - Pine is
 * invoked exactly once per combination, never here), computes every
 * candidate's Train/Test metrics, symbol/time robustness, parameter
 * stability, Robustness Score, degradation, and warnings, then ranks by
 * the selected objective. Zero Pine/RNG/trade-generation of its own -
 * this file only calls the other pure modules in this directory, which is
 * exactly what makes it unit-testable against hand-built ScanTradeRecord[]
 * fixtures (see optimizationEngine.test.ts's 5 mandated scenarios) without
 * a live Pine run or worker.
 */
export interface OptimizationEngineInput {
  combos: ParameterCombination[];
  defs: ParameterDef[];
  /** Each combination's full trade set across the whole configured date
   * range - generated once per combination, split here purely by exitTime. */
  tradesByCombo: Map<string, ScanTradeRecord[]>;
  range: DateRange;
  trainTestSplit: TrainTestSplitConfig;
  minSampleSize: number;
  /** null skips Walk-Forward Validation entirely (it's optional/slower -
   * see StrategyOptimizationPanel.tsx). */
  walkForwardFolds: number | null;
  objective: OptimizationObjective;
}

/** The score used for BOTH parameter-stability neighbor comparison and the
 * Walk-Forward per-fold train-only selection - Training Total R, per
 * stability.ts's own worked example. Kept as one named function so both
 * call sites are provably using the identical definition of "how good is
 * this combination", never two subtly different notions of "best". */
function trainTotalRScoreOf(trades: ScanTradeRecord[]): number {
  return computeCandidateMetrics(trades, 1).totalR;
}

function riskAdjustedScore(totalR: number, maxDrawdownR: number): number {
  return totalR / Math.max(1, Math.abs(maxDrawdownR));
}

function objectiveScore(candidate: CandidateResult, objective: OptimizationObjective): number {
  switch (objective) {
    case "robustness":
      return candidate.robustness.total;
    case "oosEv":
      return candidate.testMetrics.expectedValue;
    case "oosTotalR":
      return candidate.testMetrics.totalR;
    case "riskAdjusted":
      return riskAdjustedScore(candidate.testMetrics.totalR, candidate.testMetrics.maxDrawdownR);
  }
}

export function runOptimizationEngine(input: OptimizationEngineInput): OptimizationRunSummary {
  const { combos, defs, tradesByCombo, range, trainTestSplit, minSampleSize, walkForwardFolds, objective } = input;

  // Pass 1: every combination's Train/Test split and Training score (the
  // score stability/robustness need is itself derived from Train data
  // only, per the module's no-leakage rule - Test data plays no part in
  // ranking, stability, or the robust-region computation below).
  const splits = new Map(combos.map((c) => [c.key, splitTrainTest(tradesByCombo.get(c.key) ?? [], range, trainTestSplit)]));
  const trainScoreOf = (comboKey: string): number => trainTotalRScoreOf(splits.get(comboKey)?.train ?? []);

  // Pass 2: stability needs every OTHER combination's train score already
  // available, so it runs after pass 1 but before final assembly.
  const stabilityByKey = new Map(combos.map((c) => [c.key, computeStability(c, combos, defs, trainScoreOf)]));

  const candidates: CandidateResult[] = combos.map((combo) => {
    const split = splits.get(combo.key)!;
    const trainMetrics = computeCandidateMetrics(split.train, minSampleSize);
    const testMetrics = computeCandidateMetrics(split.test, minSampleSize);
    const symbolRobustness = computeSymbolRobustness(split.train);
    const timeRobustness = computeTimeRobustness(split.train);
    const stability = stabilityByKey.get(combo.key)!;
    const robustness = computeRobustnessScore(trainMetrics, symbolRobustness, timeRobustness, stability);
    const evDegradationPct = computeDegradationPct(trainMetrics.expectedValue, testMetrics.expectedValue);
    const totalRDegradationPct = computeDegradationPct(trainMetrics.totalR, testMetrics.totalR);
    const warnings = generateOverfitWarnings({ evDegradationPct, totalRDegradationPct, stability, symbolRobustness, timeRobustness, testMetrics });

    return {
      combination: combo,
      trainMetrics,
      testMetrics,
      symbolRobustness,
      timeRobustness,
      stability,
      robustness,
      warnings,
      evDegradationPct,
      totalRDegradationPct,
    };
  });

  const baseline = candidates.find((c) => c.combination.isBaseline) ?? candidates[0];

  const insufficientSampleCandidates = candidates.filter((c) => c.trainMetrics.insufficientSample || c.testMetrics.insufficientSample);
  // Structural exclusion, per spec: an insufficient sample is never
  // score-inflated into the ranking - it is simply not ranked at all,
  // though it remains visible (with its own warning) in `candidates`.
  const ranked = candidates
    .filter((c) => !c.trainMetrics.insufficientSample && !c.testMetrics.insufficientSample)
    .sort((a, b) => objectiveScore(b, objective) - objectiveScore(a, objective));

  const robustRegion = findRobustRegion(
    combos,
    defs,
    trainScoreOf,
    (key) => stabilityByKey.get(key)!
  );

  const walkForward =
    walkForwardFolds == null
      ? null
      : runWalkForward({ combos, tradesByCombo, range, folds: walkForwardFolds, minSampleSize, selectionScoreOf: trainTotalRScoreOf });

  return {
    baseline,
    candidates,
    ranked,
    robustRegion,
    walkForward,
    combinationsTested: combos.length,
    validCandidates: candidates.length - insufficientSampleCandidates.length,
    insufficientSampleCount: insufficientSampleCandidates.length,
  };
}
