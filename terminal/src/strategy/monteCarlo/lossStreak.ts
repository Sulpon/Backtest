/**
 * Losing Streak Probability - an exact ANALYTICAL calculation, deliberately
 * NOT Monte Carlo (per spec: "Do NOT blindly run Monte Carlo if an exact
 * probability can be calculated efficiently"). Independent of RR, risk %,
 * account balance, or any Monte Carlo engine/RNG/worker - it is a pure
 * function of (win rate, sequence length, streak length) only.
 *
 * QUESTION ANSWERED (precisely, per spec - this is NOT any of the several
 * similar-sounding but wrong questions the spec explicitly warns against):
 * "What is the probability that somewhere in N independent trades, there is
 * at least one run of X or more CONSECUTIVE losses?" - i.e.
 * P(max consecutive losses >= X), not P(exactly X losses), not P(first X
 * trades are losses), not an "average streak length".
 *
 * METHOD: a Markov-chain recurrence over the current trailing losing-streak
 * length, tracking only states 0..X-1 ("no run of X yet"). Any transition
 * that would reach length X is a run of X occurring - those paths are
 * simply not tracked further (their probability mass is implicitly
 * absorbed into "the event happened"), so:
 *
 *   P(at least X consecutive losses in N trades) = 1 - P(never reaches
 *   state X within N trades)
 *
 * Let dp[n][k] = probability that after n trades, no run of X losses has
 * occurred yet AND the current trailing losing streak has length exactly k
 * (k in 0..X-1). Transitions for trade n+1:
 *   - a WIN (prob = winProb) resets the streak: contributes to dp[n+1][0]
 *     from every dp[n][k].
 *   - a LOSS (prob = lossProb) extends the streak: dp[n][k] contributes to
 *     dp[n+1][k+1] - EXCEPT from k=X-1, where a loss would reach state X
 *     (the event) and is therefore dropped (not carried forward).
 *
 * dp[0][0] = 1, dp[0][k>0] = 0. After N trades:
 *   P(no run of X) = sum_k dp[N][k]
 *   P(at least X)  = 1 - P(no run of X)
 *
 * This is O(N*X) time and O(X) space per (winRate, streakLength) cell -
 * for the matrix's worst case (19 win rates x 10 streak lengths x N=5000)
 * that's under 10M floating-point operations total, comfortably
 * sub-100ms on the main thread - no worker needed for this table.
 */

export interface LossStreakMatrixConfig {
  /** Percentages, e.g. [5, 10, ..., 95] - the matrix's rows. */
  winRatesPct: number[];
  sequenceLength: number;
  /** e.g. [1, 2, ..., 10] - the matrix's columns. */
  streakLengths: number[];
}

export interface LossStreakMatrix {
  winRatesPct: number[];
  streakLengths: number[];
  sequenceLength: number;
  /** probabilities[rowIndex][colIndex], each a percentage (0-100). */
  probabilities: number[][];
}

/**
 * P(at least `streakLength` consecutive losses somewhere in `sequenceLength`
 * independent trades), for a strategy with `winRatePct`% win rate. Returns
 * a fraction (0-1) - callers format as a percentage.
 *
 * Degenerate inputs are handled by the recurrence itself, not by special-
 * casing (verified in lossStreak.test.ts against every one of the spec's
 * own edge cases):
 *  - streakLength <= 0: returns 1 (a "streak of zero" is vacuously always
 *    already true) - not a case the UI ever constructs, but defined.
 *  - streakLength > sequenceLength: mechanically returns 0 (the DP's
 *    absorbing state X can never be reached in fewer than X trades).
 *  - winRatePct = 100 (lossProb = 0): returns 0 for every streakLength > 0.
 *  - winRatePct = 0 (lossProb = 1): returns 1 for every streakLength <=
 *    sequenceLength.
 *  - sequenceLength = 1, streakLength = 1: returns exactly `1 - winRate`
 *    (the loss probability itself).
 */
export function probabilityOfLossStreak(winRatePct: number, sequenceLength: number, streakLength: number): number {
  if (streakLength <= 0) return 1;
  if (sequenceLength <= 0) return 0;
  if (streakLength > sequenceLength) return 0;

  const winProb = winRatePct / 100;
  const lossProb = 1 - winProb;
  const x = streakLength;

  // dp[k] = P(no run of X yet, current trailing streak length = k), k in [0, x).
  let dp = new Float64Array(x);
  dp[0] = 1;
  for (let n = 0; n < sequenceLength; n++) {
    let sum = 0;
    for (let k = 0; k < x; k++) sum += dp[k];
    const next = new Float64Array(x);
    next[0] = sum * winProb;
    for (let k = 1; k < x; k++) next[k] = dp[k - 1] * lossProb;
    dp = next;
  }

  let noRun = 0;
  for (let k = 0; k < x; k++) noRun += dp[k];
  // Clamp to [0,1]: repeated floating-point summation over `sequenceLength`
  // iterations can drift by a machine-epsilon amount (e.g. -6.66e-14
  // instead of exactly 0), most visible at larger streak lengths - a
  // mathematically valid probability is never outside this range, so this
  // is a rounding-error clamp, not a change to the underlying formula.
  return Math.min(1, Math.max(0, 1 - noRun));
}

/** Builds the full Losing Streak Probability matrix - one
 * probabilityOfLossStreak() call per (winRate, streakLength) cell, each
 * independent of the others (no shared state, trivially fast enough to
 * run synchronously on the main thread - see this module's own doc
 * comment for the operation-count bound). Probabilities are percentages
 * (0-100), matching this app's other percentage-displaying tables. */
export function buildLossStreakMatrix(config: LossStreakMatrixConfig): LossStreakMatrix {
  const probabilities = config.winRatesPct.map((wr) =>
    config.streakLengths.map((x) => probabilityOfLossStreak(wr, config.sequenceLength, x) * 100)
  );
  return {
    winRatesPct: config.winRatesPct,
    streakLengths: config.streakLengths,
    sequenceLength: config.sequenceLength,
    probabilities,
  };
}

/** Default rows: 5%, 10%, ..., 95%. */
export const DEFAULT_LOSS_STREAK_WIN_RATES = Array.from({ length: 19 }, (_, i) => (i + 1) * 5);
/** Default columns: 1 through 20. */
export const DEFAULT_LOSS_STREAK_LENGTHS = Array.from({ length: 20 }, (_, i) => i + 1);
export const DEFAULT_LOSS_STREAK_SEQUENCE_LENGTH = 1000;
export const LOSS_STREAK_SEQUENCE_LENGTH_PRESETS = [100, 250, 500, 1000, 5000];
