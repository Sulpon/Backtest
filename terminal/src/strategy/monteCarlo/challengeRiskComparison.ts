import { createRng } from "./rng";
import { RISK_LEVELS_PCT } from "./riskEquity";
import { simulateChallengeFromSequence } from "./challengeEngine";
import { aggregateChallengeStats, type ChallengeAggregateStats } from "./challengeStatistics";
import type { ChallengeConfig } from "./challengeTypes";

export interface ChallengeRiskComparisonRow {
  riskPct: number;
  stats: ChallengeAggregateStats;
}

/**
 * Re-applies EACH of the canonical risk levels (riskEquity.ts's
 * RISK_LEVELS_PCT - the exact same list the generic Monte Carlo Risk
 * Comparison uses) to the SAME retained per-attempt R sequences a prior
 * challengeEngine.ts run already generated (see
 * ChallengeRawResult.retainedRSequences's doc comment) - never running a
 * second batch of fresh, independent simulations per risk level. This is
 * "reuse underlying simulation sequences when possible instead of running
 * completely redundant simulations for every risk level", per spec: the
 * rows differ only in position size, never in which R outcomes occurred.
 *
 * Each row's 90%-confidence-cost journeys use their own deterministic
 * sub-seed (`seed + 1000 + levelIndex`) - reproducible from the same
 * top-level seed, but not identical across rows (each row's journeys
 * resample from that row's OWN outcomes, which differ by risk level).
 */
export function challengeRiskComparison(
  retainedRSequences: number[][],
  challenge: ChallengeConfig,
  accountSize: number,
  tradesPerPhaseCap: number,
  tradesPerDay: number | null,
  fee: number,
  seed: number
): ChallengeRiskComparisonRow[] {
  return RISK_LEVELS_PCT.map((riskPct, levelIndex) => {
    const n = retainedRSequences.length;
    const outcomes = new Uint8Array(n);
    const tradesUsed = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const attempt = simulateChallengeFromSequence(retainedRSequences[i], challenge, riskPct, accountSize, tradesPerPhaseCap, tradesPerDay);
      outcomes[i] = attempt.outcome === "PASS" ? 1 : 0;
      tradesUsed[i] = attempt.tradesUsed;
    }
    const rng = createRng(seed + 1000 + levelIndex);
    return { riskPct, stats: aggregateChallengeStats(outcomes, tradesUsed, fee, rng) };
  });
}
