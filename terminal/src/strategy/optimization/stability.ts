import { gridNeighbors } from "./parameterSpace";
import type { ParameterCombination, ParameterDef, RobustRegion, StabilityResult } from "./types";

/**
 * Parameter stability - isolated-peak detection and robust-region
 * identification. Operates on an abstract per-combination `score` (the
 * caller supplies `scoreOf`, e.g. training Total R - see
 * optimizationEngine.ts) so this file has zero knowledge of trades/Pine
 * and is fully testable against hand-built numeric grids, per spec's
 * explicit instruction: "Do not hardcode this exact result into the
 * engine - the test should validate the stability methodology," not one
 * fixed scenario.
 *
 * WORKED EXAMPLE (plateau vs. spike), RR parameter, Total R score:
 *   RR=2.0 -> 38R   RR=2.2 -> 41R   RR=2.4 -> 90R   RR=2.6 -> 40R   RR=2.8 -> 39R
 * RR=2.4's neighbors are RR=2.2 (41R) and RR=2.6 (40R), averaging 40.5R.
 * isolationRatio = (90 - 40.5) / max(1, 40.5) ~= 1.22 -> far above
 * ISOLATION_RATIO_THRESHOLD -> flagged an isolated peak (a single lucky
 * parameter value, not a real edge). RR=2.2's neighbors are RR=2.0 (38R)
 * and RR=2.4 (90R) averaging 64R; RR=2.2 itself (41R) scores BELOW that
 * average, so its isolationRatio is negative - never flagged. The
 * 38/41/40/39 cluster at RR in [2.0,2.2]u[2.6,2.8] is the actual stable
 * plateau this module is meant to surface via findRobustRegion, while the
 * one-off 90R spike at RR=2.4 is excluded from it.
 */

/** isolationRatio above this is flagged an isolated peak rather than part
 * of a plateau: the candidate scores at least 50% higher than the average
 * of its immediate grid neighbors (see the module doc comment's worked
 * example). Fixed and documented, not tunable - it only ever feeds a
 * warning label, never a score cutoff. */
export const ISOLATION_RATIO_THRESHOLD = 0.5;

/** A candidate within this fraction of the best NON-SPIKE score's own
 * magnitude (floored at 1, so a near-zero best score doesn't collapse the
 * margin to nothing) counts as "near-peak" for robust-region purposes -
 * see findRobustRegion. Deliberately measured against the best score AMONG
 * NON-ISOLATED candidates, never the grid's raw max: an isolated spike (by
 * definition an outlier) would otherwise inflate the bar so high that the
 * real plateau around it - the very thing this function exists to find -
 * gets excluded too. */
const NEAR_PEAK_TOLERANCE_FRACTION = 0.15;

/**
 * Stability of one combination relative to its immediate grid neighbors
 * (see parameterSpace.ts's gridNeighbors - points differing by exactly one
 * step in exactly one parameter). A combination with no neighbors in the
 * searched grid (e.g. a single-value parameter, or the grid's own corner
 * with every axis already at an extreme) has undefined stability - not a
 * spike, not a plateau, just unmeasurable - and is never flagged.
 */
export function computeStability(
  combo: ParameterCombination,
  allCombos: ParameterCombination[],
  defs: ParameterDef[],
  scoreOf: (comboKey: string) => number
): StabilityResult {
  const neighbors = gridNeighbors(combo, allCombos, defs);
  if (neighbors.length === 0) {
    return { comboKey: combo.key, neighborAvgScore: null, isolationRatio: null, isIsolatedPeak: false };
  }
  const neighborAvgScore = neighbors.reduce((sum, n) => sum + scoreOf(n.key), 0) / neighbors.length;
  const ownScore = scoreOf(combo.key);
  const isolationRatio = (ownScore - neighborAvgScore) / Math.max(1, Math.abs(neighborAvgScore));
  return { comboKey: combo.key, neighborAvgScore, isolationRatio, isIsolatedPeak: isolationRatio > ISOLATION_RATIO_THRESHOLD };
}

/**
 * The contiguous parameter ranges spanned by every "near-peak, not an
 * isolated spike" combination - i.e. the plateau, per this module's own
 * worked example. Isolated spikes are excluded FIRST, and "near-peak" is
 * then judged against the best score among what remains - this two-step
 * order is what keeps a lucky outlier from also disqualifying the real
 * plateau sitting right next to it (see NEAR_PEAK_TOLERANCE_FRACTION's own
 * doc comment). Returns null (per spec: "explicit 'No stable parameter
 * region detected' fallback") when there are no parameters/combinations to
 * describe a region over, or in the degenerate case where literally every
 * combination is itself flagged an isolated spike.
 *
 * The returned [min,max] per parameter is a bounding envelope of the
 * plateau's own combinations, not a literal list of every included value -
 * it can therefore also span a single excluded spike sitting strictly
 * between two plateau points (e.g. a plateau at RR 2.0-2.2 and 2.6-2.8
 * around an excluded RR=2.4 spike bounds as [2.0, 2.8]), matching this
 * type's own doc comment ("the contiguous plateau ... this candidate sits
 * inside").
 */
export function findRobustRegion(
  combos: ParameterCombination[],
  defs: ParameterDef[],
  scoreOf: (comboKey: string) => number,
  stabilityOf: (comboKey: string) => StabilityResult
): RobustRegion | null {
  if (defs.length === 0 || combos.length === 0) return null;

  const nonSpike = combos.filter((c) => !stabilityOf(c.key).isIsolatedPeak);
  if (nonSpike.length === 0) return null;

  const bestScore = Math.max(...nonSpike.map((c) => scoreOf(c.key)));
  const margin = NEAR_PEAK_TOLERANCE_FRACTION * Math.max(Math.abs(bestScore), 1);
  const stablePlateau = nonSpike.filter((c) => scoreOf(c.key) >= bestScore - margin);

  const ranges: Record<string, { min: number; max: number }> = {};
  for (const def of defs) {
    const values = stablePlateau.map((c) => c.values[def.key]);
    ranges[def.key] = { min: Math.min(...values), max: Math.max(...values) };
  }
  return { ranges };
}
