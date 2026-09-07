import { mean, median, percentile } from "./statistics";
import type { Rng } from "./types";

/**
 * Challenge-level aggregate statistics - built entirely on top of
 * statistics.ts's existing mean/median/percentile (no second stats
 * implementation), operating on a challenge run's outcomes (1=PASS/0=FAIL)
 * and per-attempt trade counts.
 */

export interface TradesToSuccessStats {
  mean: number;
  median: number;
  p5: number;
  p95: number;
}

/** null when there were zero PASS outcomes to measure (no successful
 * attempt to average/median over) - never NaN. */
export function tradesToSuccessStats(outcomes: Uint8Array, tradesUsed: Int32Array): TradesToSuccessStats | null {
  const successTrades: number[] = [];
  for (let i = 0; i < outcomes.length; i++) if (outcomes[i] === 1) successTrades.push(tradesUsed[i]);
  if (successTrades.length === 0) return null;
  return {
    mean: mean(successTrades),
    median: median(successTrades),
    p5: percentile(successTrades, 5),
    p95: percentile(successTrades, 95),
  };
}

/** Fraction (0-1), not a percentage - callers format for display. */
export function passRateOf(outcomes: Uint8Array): number {
  if (outcomes.length === 0) return 0;
  let passes = 0;
  for (let i = 0; i < outcomes.length; i++) passes += outcomes[i];
  return passes / outcomes.length;
}

/**
 * Expected number of challenge attempts to reach one PASS = 1 / passRate.
 * This is exact (not approximate) under this simulator's own model: every
 * attempt draws a fresh, independent R sequence, so successive attempts
 * are i.i.d. Bernoulli(passRate) trials, and 1/p is the standard expected
 * number of trials to the first success of a geometric distribution.
 * null (never Infinity) when passRate is 0 - "effectively impossible
 * under this configuration", per spec.
 */
export function expectedAttempts(passRate: number): number | null {
  return passRate > 0 ? 1 / passRate : null;
}

/**
 * expectedAttempts x average trades consumed by a SUCCESSFUL attempt -
 * the spec's own explicit formula ("Expected total trades: expected
 * attempts x average trades per successful attempt"). This is a
 * deliberate simplification the spec itself specifies: it does not
 * additionally add the trades consumed by the failed attempts along the
 * way, only the expected-attempts-many repetitions of a successful
 * attempt's own trade count.
 */
export function expectedTradesToFund(attempts: number | null, avgTradesPerSuccess: number | null): number | null {
  if (attempts == null || avgTradesPerSuccess == null) return null;
  return attempts * avgTradesPerSuccess;
}

/** Challenge Fee x Expected Attempts. null (never a fabricated number)
 * when attempts is null. */
export function expectedCost(attempts: number | null, fee: number): number | null {
  return attempts == null ? null : attempts * fee;
}

/**
 * 90th-percentile total cost across simulated FUNDING JOURNEYS: "keep
 * purchasing challenge attempts until one passes" (per spec), built by
 * resampling WITH REPLACEMENT from the already-simulated pass/fail
 * outcomes - the actual simulated sequences, not a closed-form
 * approximation. Uses the caller-supplied deterministic `rng` (continued,
 * never restarted) so the same seed + config always reproduces the same
 * value. `maxAttemptsPerJourney` only exists to guarantee termination when
 * passRate is very low; it is never reached in practice once passRate is
 * verified > 0 below. Returns null when passRate is 0 (every journey would
 * need unbounded attempts - "effectively impossible", never a fabricated
 * capped number).
 */
export function confidenceCost90(outcomes: Uint8Array, fee: number, rng: Rng, journeyCount = 3000, maxAttemptsPerJourney = 500): number | null {
  const n = outcomes.length;
  if (n === 0) return null;
  let anyPass = false;
  for (let i = 0; i < n; i++) {
    if (outcomes[i] === 1) {
      anyPass = true;
      break;
    }
  }
  if (!anyPass) return null;

  const costs: number[] = new Array(journeyCount);
  for (let j = 0; j < journeyCount; j++) {
    let attempts = 0;
    let passed = false;
    while (!passed && attempts < maxAttemptsPerJourney) {
      attempts++;
      const idx = Math.min(n - 1, Math.floor(rng() * n));
      if (outcomes[idx] === 1) passed = true;
    }
    costs[j] = attempts * fee;
  }
  return percentile(costs, 90);
}

/**
 * Probability of `threshold`-or-more CONSECUTIVE FAILED CHALLENGE
 * ATTEMPTS (never individual losing trades) starting from a fresh
 * sequence of attempts: (1 - passRate)^threshold. Exact under this
 * simulator's i.i.d.-attempts model (see expectedAttempts's doc comment),
 * not an empirical approximation.
 */
export function consecutiveFailureRisk(passRate: number, threshold: number): number {
  return Math.pow(1 - passRate, threshold);
}

export interface ChallengeAggregateStats {
  /** Percentage (0-100), for direct display. */
  passRate: number;
  failRate: number;
  tradesToSuccess: TradesToSuccessStats | null;
  expectedAttempts: number | null;
  expectedTradesToFund: number | null;
  expectedCost: number | null;
  confidenceCost90: number | null;
  /** Percentages (0-100). */
  failureRisk3Plus: number;
  failureRisk5Plus: number;
  failureRisk10Plus: number;
}

/** Every "PRIMARY RESULTS" / "TRADES PER SUCCESSFUL ATTEMPT" / "EXPECTED
 * ..." / "CONSECUTIVE FAILURE RISK" metric the spec lists, computed from
 * one challenge run's full `outcomes`/`tradesUsed` arrays (all
 * `numSimulations` entries) - used both for the primary result (the run's
 * own configured risk level) and, per risk level, by
 * challengeRiskComparison.ts. */
export function aggregateChallengeStats(outcomes: Uint8Array, tradesUsed: Int32Array, fee: number, rng: Rng): ChallengeAggregateStats {
  const passRate = passRateOf(outcomes);
  const tts = tradesToSuccessStats(outcomes, tradesUsed);
  const attempts = expectedAttempts(passRate);
  const trades = expectedTradesToFund(attempts, tts?.mean ?? null);
  const cost = expectedCost(attempts, fee);
  const conf90 = confidenceCost90(outcomes, fee, rng);
  return {
    passRate: passRate * 100,
    failRate: (1 - passRate) * 100,
    tradesToSuccess: tts,
    expectedAttempts: attempts,
    expectedTradesToFund: trades,
    expectedCost: cost,
    confidenceCost90: conf90,
    failureRisk3Plus: consecutiveFailureRisk(passRate, 3) * 100,
    failureRisk5Plus: consecutiveFailureRisk(passRate, 5) * 100,
    failureRisk10Plus: consecutiveFailureRisk(passRate, 10) * 100,
  };
}

export interface BreakEvenAnalysis {
  expectedCost: number | null;
  /** % profit (BEFORE the profit split is applied) the funded account
   * would need to generate for the trader's share of it (profitSplitPct%)
   * to equal `expectedCost` - derived only from numbers already computed/
   * supplied (expectedCost, accountSize, profitSplitPct). Deliberately
   * does NOT assume any particular future performance of the funded
   * account - see `assumptionNote`, per spec's "do not invent
   * assumptions not supplied by the user". null when expectedCost is null
   * or profitSplitPct is 0 (no share to recover cost from). */
  breakEvenFundedProfitPct: number | null;
  assumptionNote: string;
}

const ASSUMPTION_NOTE =
  "This is the profit percentage (before the profit split) the funded account would need to generate for your share of it to equal the expected cost of getting funded - it does not assume the funded account will actually achieve this, and no assumption is made about its future performance.";

export function breakEvenAnalysis(expectedCostValue: number | null, accountSize: number, profitSplitPct: number): BreakEvenAnalysis {
  if (expectedCostValue == null || profitSplitPct <= 0 || accountSize <= 0) {
    return { expectedCost: expectedCostValue, breakEvenFundedProfitPct: null, assumptionNote: ASSUMPTION_NOTE };
  }
  const traderShare = profitSplitPct / 100;
  const breakEvenFundedProfitPct = (expectedCostValue / (accountSize * traderShare)) * 100;
  return { expectedCost: expectedCostValue, breakEvenFundedProfitPct, assumptionNote: ASSUMPTION_NOTE };
}
