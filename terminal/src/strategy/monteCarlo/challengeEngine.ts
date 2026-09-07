import { evenlySpacedIndices, nextOutcomeR } from "./engine";
import { createRng } from "./rng";
import { equityMultiplierForR } from "./riskEquity";
import type { OutcomeSource, Rng } from "./types";
import type {
  ChallengeAttemptResult,
  ChallengeConfig,
  ChallengeRawResult,
  ChallengeRunConfig,
  ChallengeStopReason,
  PhaseRules,
} from "./challengeTypes";

/**
 * Challenge Simulator engine - built ON TOP OF the existing generic Monte
 * Carlo primitives (engine.ts's nextOutcomeR/createRng, riskEquity.ts's
 * equityMultiplierForR), never a second RNG or a second per-trade outcome
 * model. This module only adds what's genuinely new: an account-equity
 * walk against a profit target and a drawdown floor, stopping at the
 * first PASS or FAIL.
 *
 * ASSUMPTIONS (explicit, since the spec has no single canonical prop-firm
 * rulebook to defer to - each is a deliberate, documented simplification,
 * not an invented number):
 *  - Each phase of a challenge (Phase 1, and Phase 2 if configured) begins
 *    with equity reset to `accountSize`, not carried over from the
 *    previous phase's ending equity - this matches how real prop-firm
 *    evaluations almost universally treat Phase 2 as a fresh account, and
 *    the spec's own "reset ... apply Phase 2 rules" wording.
 *  - `tradesPerPhaseCap` (the UI's "Trades / Simulation" setting) is a
 *    PER-PHASE trade budget, not a total-across-both-phases budget - a
 *    two-phase attempt may therefore consume up to 2x this many trades.
 *  - A phase that exhausts its trade budget without reaching its target
 *    or breaching a drawdown limit resolves to a top-level FAIL (see
 *    challengeTypes.ts's ChallengeStopReason doc comment) - the spec's own
 *    "CHALLENGE OUTCOME STATES" section defines no third top-level state.
 *  - Daily drawdown is measured against the equity value at the START of
 *    the current simulated trading day (not an intraday running peak) -
 *    the simplest, clearly-documented model matching common real
 *    "static daily loss limit" conventions, and resets every
 *    `tradesPerDay` trades within a phase (also reset at the start of a
 *    new phase).
 */

/** Draws exactly `totalLength` independent R outcomes from `source`, via
 * the SAME nextOutcomeR/createRng pair the generic engine uses - no second
 * RNG, no second outcome model. Drawn up front (rather than lazily during
 * the account walk) so the identical array can be replayed later at a
 * DIFFERENT risk level for Risk Comparison (see
 * challengeRiskComparison.ts) - "the same underlying strategy outcome
 * sequences", per spec. */
export function generateChallengeRSequence(source: OutcomeSource, rng: Rng, totalLength: number): number[] {
  const seq = new Array<number>(totalLength);
  for (let i = 0; i < totalLength; i++) seq[i] = nextOutcomeR(source, rng);
  return seq;
}

interface PhaseWalkResult {
  passed: boolean;
  stopReason: ChallengeStopReason;
  tradesConsumed: number;
  equitySegment: number[];
  thresholdSegment: number[];
}

/** Walks one phase's account equity against a slice of the pre-generated R
 * sequence. Stops at the first of: profit target reached (PASS), max or
 * daily drawdown breached (FAIL), or the phase's own trade budget
 * exhausted (FAIL, stopReason "exhausted"). */
function walkPhase(
  rSeq: readonly number[],
  offset: number,
  cap: number,
  rules: PhaseRules,
  accountSize: number,
  riskPct: number,
  drawdownType: "initial" | "trailing",
  dailyDrawdownPct: number | null,
  tradesPerDay: number | null
): PhaseWalkResult {
  const targetLevel = accountSize * (1 + rules.profitTargetPct / 100);
  const initialFloor = accountSize * (1 - rules.maxDrawdownPct / 100);
  let trailingFloor = initialFloor;
  let peak = accountSize;

  let equity = accountSize;
  let dayStartEquity = accountSize;
  let dayTradeCount = 0;

  const equitySegment: number[] = [];
  const thresholdSegment: number[] = [];

  const n = Math.max(0, Math.min(cap, rSeq.length - offset));
  for (let i = 0; i < n; i++) {
    const r = rSeq[offset + i];
    equity *= equityMultiplierForR(r, riskPct);

    if (drawdownType === "trailing" && equity > peak) {
      peak = equity;
      // "Do not allow the drawdown threshold to move downward" - it only
      // ever rises alongside a new equity peak, and is clamped to never
      // regress even if equity later falls back.
      const candidateFloor = peak - accountSize * (rules.maxDrawdownPct / 100);
      if (candidateFloor > trailingFloor) trailingFloor = candidateFloor;
    }
    const activeFloor = drawdownType === "trailing" ? trailingFloor : initialFloor;

    equitySegment.push(equity);
    thresholdSegment.push(activeFloor);
    dayTradeCount++;

    if (equity <= activeFloor) {
      return { passed: false, stopReason: "maxDrawdown", tradesConsumed: i + 1, equitySegment, thresholdSegment };
    }
    if (dailyDrawdownPct != null && tradesPerDay != null && dayStartEquity - equity >= accountSize * (dailyDrawdownPct / 100)) {
      return { passed: false, stopReason: "dailyDrawdown", tradesConsumed: i + 1, equitySegment, thresholdSegment };
    }
    if (equity >= targetLevel) {
      return { passed: true, stopReason: "target", tradesConsumed: i + 1, equitySegment, thresholdSegment };
    }
    if (tradesPerDay != null && dayTradeCount >= tradesPerDay) {
      dayTradeCount = 0;
      dayStartEquity = equity;
    }
  }
  return { passed: false, stopReason: "exhausted", tradesConsumed: n, equitySegment, thresholdSegment };
}

/**
 * One full challenge attempt (Phase 1, and Phase 2 only if configured and
 * Phase 1 passes) against a pre-generated R sequence - see this module's
 * own doc comment for the documented phase-reset/trade-budget assumptions.
 *
 * `rSeq` must be at least `tradesPerPhaseCap` long for a single-phase
 * challenge, or `2 * tradesPerPhaseCap` long for a two-phase challenge
 * (Phase 1 consumes rSeq[0, cap), Phase 2 - only if reached - consumes
 * rSeq[cap, 2*cap)).
 */
export function simulateChallengeFromSequence(
  rSeq: readonly number[],
  challenge: ChallengeConfig,
  riskPct: number,
  accountSize: number,
  tradesPerPhaseCap: number,
  tradesPerDay: number | null
): ChallengeAttemptResult {
  const dailyDD = challenge.dailyDrawdownPct;
  const phase1Walk = walkPhase(rSeq, 0, tradesPerPhaseCap, challenge.phase1, accountSize, riskPct, challenge.drawdownType, dailyDD, tradesPerDay);

  if (!phase1Walk.passed) {
    return {
      outcome: "FAIL",
      tradesUsed: phase1Walk.tradesConsumed,
      stopReason: phase1Walk.stopReason,
      phaseOutcomes: ["PHASE_1_FAIL"],
      equityPath: phase1Walk.equitySegment,
      thresholdPath: phase1Walk.thresholdSegment,
      phaseBoundaryTradeIndex: null,
    };
  }

  if (challenge.challengeType === "single" || !challenge.phase2) {
    return {
      outcome: "PASS",
      tradesUsed: phase1Walk.tradesConsumed,
      stopReason: phase1Walk.stopReason,
      phaseOutcomes: ["PHASE_1_PASS"],
      equityPath: phase1Walk.equitySegment,
      thresholdPath: phase1Walk.thresholdSegment,
      phaseBoundaryTradeIndex: null,
    };
  }

  const phase2Walk = walkPhase(
    rSeq,
    tradesPerPhaseCap,
    tradesPerPhaseCap,
    challenge.phase2,
    accountSize,
    riskPct,
    challenge.drawdownType,
    dailyDD,
    tradesPerDay
  );

  const equityPath = [...phase1Walk.equitySegment, ...phase2Walk.equitySegment];
  const thresholdPath = [...phase1Walk.thresholdSegment, ...phase2Walk.thresholdSegment];
  const phaseBoundaryTradeIndex = phase1Walk.tradesConsumed;

  if (!phase2Walk.passed) {
    return {
      outcome: "FAIL",
      tradesUsed: phase1Walk.tradesConsumed + phase2Walk.tradesConsumed,
      stopReason: phase2Walk.stopReason,
      phaseOutcomes: ["PHASE_1_PASS", "PHASE_2_FAIL"],
      equityPath,
      thresholdPath,
      phaseBoundaryTradeIndex,
    };
  }

  return {
    outcome: "PASS",
    tradesUsed: phase1Walk.tradesConsumed + phase2Walk.tradesConsumed,
    stopReason: phase2Walk.stopReason,
    phaseOutcomes: ["PHASE_1_PASS", "PHASE_2_PASS"],
    equityPath,
    thresholdPath,
    phaseBoundaryTradeIndex,
  };
}

/** ~50-100 representative paths, per spec - never "thousands". Reuses
 * engine.ts's own evenlySpacedIndices rather than a second sampling
 * function. */
const REPRESENTATIVE_PATH_COUNT = 80;
/** Bounds Risk Comparison's per-attempt-R-sequence retention, mirroring
 * engine.ts's identical RETAINED_R_SEQUENCE_CAP/reasoning. */
const RETAINED_R_SEQUENCE_CAP = 2000;
/** Batched progress reporting, mirroring engine.ts's PROGRESS_BATCH_SIZE. */
const PROGRESS_BATCH_SIZE = 500;

export interface RunChallengeMonteCarloOptions {
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Runs `config.numSimulations` independent challenge attempts, each
 * starting from a FRESH challenge account (per spec) - the top-level
 * orchestration loop, directly analogous to engine.ts's runMonteCarlo but
 * producing pass/fail + trades-used per attempt instead of plain R
 * statistics. Pure function - safe to run inside the existing isolated
 * Monte Carlo worker unchanged (see monteCarlo.worker.ts's dispatch).
 */
export function runChallengeMonteCarlo(config: ChallengeRunConfig, options: RunChallengeMonteCarloOptions = {}): ChallengeRawResult {
  const { numSimulations, tradesPerPhaseCap, seed, source, riskPct, accountSize, challenge, tradesPerDay } = config;
  const rng = createRng(seed);
  const phaseCount = challenge.challengeType === "two-phase" ? 2 : 1;
  const sequenceLength = tradesPerPhaseCap * phaseCount;

  const outcomes = new Uint8Array(numSimulations);
  const tradesUsed = new Int32Array(numSimulations);

  const representativeSimIndices = new Set(evenlySpacedIndices(numSimulations, REPRESENTATIVE_PATH_COUNT));
  const representativePaths: ChallengeAttemptResult[] = [];

  const retainedCap = Math.min(RETAINED_R_SEQUENCE_CAP, numSimulations);
  const retainStride = Math.max(1, Math.floor(numSimulations / Math.max(1, retainedCap)));
  const retainedRSequences: number[][] = [];

  for (let i = 0; i < numSimulations; i++) {
    const rSeq = generateChallengeRSequence(source, rng, sequenceLength);
    const attempt = simulateChallengeFromSequence(rSeq, challenge, riskPct, accountSize, tradesPerPhaseCap, tradesPerDay);

    outcomes[i] = attempt.outcome === "PASS" ? 1 : 0;
    tradesUsed[i] = attempt.tradesUsed;

    if (representativeSimIndices.has(i)) representativePaths.push(attempt);
    if (retainedRSequences.length < retainedCap && i % retainStride === 0) retainedRSequences.push(rSeq);

    if (options.onProgress && ((i + 1) % PROGRESS_BATCH_SIZE === 0 || i === numSimulations - 1)) {
      options.onProgress(i + 1, numSimulations);
    }
  }

  return { seed, numSimulations, accountSize, riskPct, challenge, outcomes, tradesUsed, representativePaths, retainedRSequences };
}
