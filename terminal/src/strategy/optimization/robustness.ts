import type { CandidateMetrics, RobustnessScoreBreakdown, StabilityResult, SymbolRobustnessResult, TimeRobustnessResult } from "./types";

/**
 * The Robustness Score - a transparent, fully-documented weighted sum of
 * seven [0,1] sub-scores (never a black box). Every reference constant and
 * weight below is fixed and printed here, not learned/tuned - this file
 * IS the formula's documentation, matching spec's "transparent, non-black-
 * box Robustness Score formula" requirement.
 *
 * Deliberately weighted to match this feature's core principle
 * ("ROBUSTNESS > HISTORICAL PEAK PERFORMANCE"): totalRScore (sheer
 * historical magnitude) carries the LOWEST weight of the seven, while the
 * consistency-across-symbols/consistency-across-time/parameter-stability
 * scores together outweigh it more than 4:1 - a candidate cannot reach a
 * high Robustness Score on raw historical profit alone.
 */

// Reference points below are fixed magnitudes chosen to make each raw
// quantity self-explanatory as "score = how close to this reference,
// clamped to [0,1]" - not fit to any dataset, and safe to change if this
// project's typical R-multiples ever shift meaningfully.
const EV_REFERENCE_R = 0.3; // per-trade EV of 0.3R clamps to a full evScore
const TOTAL_R_REFERENCE = 50; // 50R total over the training period clamps to a full totalRScore
const DRAWDOWN_REFERENCE_R = 20; // a 20R max drawdown clamps drawdownScore to 0
const SAMPLE_SIZE_REFERENCE = 200; // 200 training trades clamps sampleSizeScore to a full score

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** symbolConsistencyScore / timeConsistencyScore: the % of profitable
 * "buckets" (symbols or years), scored 0-1. With 0 or 1 buckets there is
 * no cross-bucket evidence either way, so this returns a neutral 0.5
 * rather than rewarding or penalizing a single-symbol/single-year run. */
function consistencyScore(profitableBuckets: number, totalBuckets: number): number {
  if (totalBuckets <= 1) return 0.5;
  return clamp01(profitableBuckets / totalBuckets);
}

/** parameterStabilityScore: a deliberately simple three-level rule rather
 * than a continuous formula (fabricating false precision from
 * isolationRatio's own magnitude would undermine "transparent" more than
 * it would help). Unmeasurable (no grid neighbors) is neutral, not
 * penalized - see stability.ts's own doc comment on why that's undefined
 * rather than bad. */
function stabilityScore(stability: StabilityResult): number {
  if (stability.isIsolatedPeak) return 0.2;
  if (stability.neighborAvgScore === null) return 0.5;
  return 1;
}

export function computeRobustnessScore(
  trainMetrics: CandidateMetrics,
  symbolRobustness: SymbolRobustnessResult,
  timeRobustness: TimeRobustnessResult,
  stability: StabilityResult
): RobustnessScoreBreakdown {
  const evScore = clamp01(trainMetrics.expectedValue / EV_REFERENCE_R);
  const totalRScore = clamp01(trainMetrics.totalR / TOTAL_R_REFERENCE);
  const drawdownScore = clamp01(1 - Math.abs(trainMetrics.maxDrawdownR) / DRAWDOWN_REFERENCE_R);
  const sampleSizeScore = clamp01(trainMetrics.trades / SAMPLE_SIZE_REFERENCE);
  const symbolConsistencyScore = consistencyScore(
    symbolRobustness.bySymbol.filter((s) => s.totalR > 0).length,
    symbolRobustness.bySymbol.length
  );
  const timeConsistencyScore = consistencyScore(timeRobustness.byYear.filter((y) => y.totalR > 0).length, timeRobustness.byYear.length);
  const parameterStabilityScore = stabilityScore(stability);

  // Fixed weights, sum to 1 exactly - see this file's own doc comment for
  // the rationale behind each weight.
  const WEIGHTS = {
    ev: 0.2,
    totalR: 0.1,
    drawdown: 0.15,
    sampleSize: 0.1,
    symbolConsistency: 0.2,
    timeConsistency: 0.15,
    parameterStability: 0.1,
  } as const;

  const total =
    (evScore * WEIGHTS.ev +
      totalRScore * WEIGHTS.totalR +
      drawdownScore * WEIGHTS.drawdown +
      sampleSizeScore * WEIGHTS.sampleSize +
      symbolConsistencyScore * WEIGHTS.symbolConsistency +
      timeConsistencyScore * WEIGHTS.timeConsistency +
      parameterStabilityScore * WEIGHTS.parameterStability) *
    100;

  return { evScore, totalRScore, drawdownScore, sampleSizeScore, symbolConsistencyScore, timeConsistencyScore, parameterStabilityScore, total };
}
