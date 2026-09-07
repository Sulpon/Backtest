import type { OutcomeSource } from "./types";

/**
 * Types for the Challenge Simulator - a mode layered ON TOP OF the existing
 * generic Monte Carlo engine (engine.ts), never a second engine. A
 * "challenge attempt" is the same kind of per-trade R sequence the generic
 * engine already draws (via engine.ts's nextOutcomeR/createRng), walked
 * through an account-equity/target/drawdown model instead of the generic
 * engine's plain cumulative-R statistics - see challengeEngine.ts.
 */

export type DrawdownType = "initial" | "trailing";
export type ChallengeType = "single" | "two-phase";

export interface PhaseRules {
  profitTargetPct: number;
  maxDrawdownPct: number;
}

export interface ChallengeConfig {
  challengeType: ChallengeType;
  phase1: PhaseRules;
  /** null when challengeType === "single" - see challengeEngine.ts's
   * simulateChallengeFromSequence for the documented "each phase resets to
   * accountSize" assumption. */
  phase2: PhaseRules | null;
  drawdownType: DrawdownType;
  /** null = daily drawdown disabled entirely. */
  dailyDrawdownPct: number | null;
  profitSplitPct: number;
  challengeFee: number;
}

/** Why a single phase's walk stopped - internal audit detail, never a
 * user-facing THIRD top-level outcome (the spec's own "CHALLENGE OUTCOME
 * STATES" section defines only PASS/FAIL at the top level, plus the four
 * PHASE_*_PASS/FAIL states for two-phase). "exhausted" (the trade budget
 * ran out before either the target or a drawdown limit was hit) still
 * resolves to a top-level FAIL - see this module's own doc comment in
 * challengeEngine.ts for why. */
export type ChallengeStopReason = "target" | "maxDrawdown" | "dailyDrawdown" | "exhausted";

export type ChallengePhaseOutcome = "PHASE_1_PASS" | "PHASE_1_FAIL" | "PHASE_2_PASS" | "PHASE_2_FAIL";

export interface ChallengeAttemptResult {
  outcome: "PASS" | "FAIL";
  /** Trades consumed across every phase actually attempted (a Phase 1
   * failure never adds Phase 2 trades - Phase 2 is never attempted). */
  tradesUsed: number;
  stopReason: ChallengeStopReason;
  phaseOutcomes: ChallengePhaseOutcome[];
  /** Account-currency equity after each trade, concatenated across every
   * phase actually attempted. */
  equityPath: number[];
  /** The active drawdown floor (in account currency) at each corresponding
   * point of `equityPath` - constant for "initial", non-decreasing for
   * "trailing" (see challengeEngine.ts's walkPhase). */
  thresholdPath: number[];
  /** Index into `equityPath`/`thresholdPath` where Phase 1 ended and Phase
   * 2 began (only set for a two-phase attempt that passed Phase 1); null
   * for single-phase attempts or an attempt that never left Phase 1. */
  phaseBoundaryTradeIndex: number | null;
}

export interface ChallengeRunConfig {
  numSimulations: number;
  /** Per-PHASE trade budget cap (a two-phase attempt may consume up to
   * 2x this many trades total) - documented assumption, see
   * challengeEngine.ts's module doc comment. */
  tradesPerPhaseCap: number;
  seed: number;
  source: OutcomeSource;
  riskPct: number;
  accountSize: number;
  challenge: ChallengeConfig;
  /** Trades grouped per simulated trading day, for daily-drawdown resets -
   * null disables daily-drawdown tracking regardless of
   * challenge.dailyDrawdownPct (both must be set for daily DD to apply). */
  tradesPerDay: number | null;
}

export interface ChallengeRawResult {
  seed: number;
  numSimulations: number;
  accountSize: number;
  riskPct: number;
  challenge: ChallengeConfig;
  /** 1 = PASS, 0 = FAIL, one entry per simulation - a typed array, same
   * memory-consciousness precedent as the generic engine's
   * MonteCarloRawResult (see types.ts). */
  outcomes: Uint8Array;
  tradesUsed: Int32Array;
  /** Full per-attempt detail (equity/threshold paths) for a bounded,
   * evenly-sampled ~50-100 subset only - the Challenge Equity Paths
   * chart's sole data source, never used for statistics (every statistic
   * is computed from the full `outcomes`/`tradesUsed` arrays). */
  representativePaths: ChallengeAttemptResult[];
  /** Full per-attempt R sequences for a bounded, evenly-sampled subset -
   * Risk Comparison's only input besides the risk levels themselves (see
   * challengeRiskComparison.ts), mirroring engine.ts's MonteCarloRawResult.
   * retainedRSequences exactly. */
  retainedRSequences: number[][];
}
