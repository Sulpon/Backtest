/**
 * Strategy Lab's theoretical (non-simulated) metrics - shown immediately
 * as the user edits Win Rate/Avg Win/Avg Loss, before "Run Simulation" is
 * ever pressed. Pure arithmetic, independent of engine.ts/rng.ts (these
 * numbers describe the Simple model's THEORETICAL expectancy, not a
 * simulated outcome).
 */

/** EV = winRate*avgWin - (1-winRate)*avgLoss, in R. Example from spec:
 * WR=40%, avgWin=+2.45R, avgLoss=1R -> 0.4*2.45 - 0.6*1 = +0.38R. */
export function expectedValueR(winRatePct: number, avgWinR: number, avgLossR: number): number {
  const wr = winRatePct / 100;
  return wr * avgWinR - (1 - wr) * avgLossR;
}

/** Win rate at which EV = 0: avgLoss / (avgWin + avgLoss). Example from
 * spec: avgWin=2.45R, avgLoss=1R -> 1/3.45 ~= 28.99%. Returns a percentage
 * (0-100), 0 when avgWin+avgLoss is 0 (avoids a NaN from 0/0). */
export function breakevenWinRatePct(avgWinR: number, avgLossR: number): number {
  const denom = avgWinR + avgLossR;
  if (denom <= 0) return 0;
  return (avgLossR / denom) * 100;
}
