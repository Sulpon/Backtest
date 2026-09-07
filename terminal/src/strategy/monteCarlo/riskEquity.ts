import { median, percentile, probabilityPositive } from "./statistics";

/**
 * Risk-sizing layer on top of the engine's R-space output. Deliberately a
 * separate module from engine.ts/statistics.ts (per the spec's "separate
 * risk/equity calculations") - R-space stays canonical; this only ever
 * converts an already-simulated R sequence into a risk-sized equity path,
 * never influences the simulation itself (position sizing doesn't change a
 * strategy's expectancy in R, per spec).
 */

/** Per-trade compounding multiplier for one R outcome at a given risk %.
 * r=+1, risk=1% -> *1.01. r=-1, risk=1% -> *0.99. r=+2, risk=1% -> *1.02.
 * Clamped at 0: a large hypothetical loss (Strategy Lab has no bound on
 * avgLossR) times a large risk % could otherwise imply negative equity,
 * which has no real trading-account meaning - an account can go to zero,
 * not below it. */
export function equityMultiplierForR(r: number, riskPct: number): number {
  return Math.max(0, 1 + r * (riskPct / 100));
}

/** Non-compounded, single-trade %, e.g. r=+2 at 1% risk = +2%. Exists only
 * to make that simple relationship explicit/testable (risk-equity.test.ts)
 * - compoundEquityFromR below is what every multi-trade equity path
 * actually uses; nothing sums this per-trade % across trades (that would
 * be exactly the "simply multiply total R by risk %" the spec forbids). */
export function simpleRiskPercent(r: number, riskPct: number): number {
  return r * riskPct;
}

/** Compounded equity path (one value per trade, in the same units as
 * `startingBalance`) - never `startingBalance + sum(r) * riskPct`, which
 * would ignore compounding entirely (the spec's explicit "do NOT simply
 * multiply total R by risk percentage" case). */
export function compoundEquityFromR(rSeq: readonly number[], riskPct: number, startingBalance: number): number[] {
  const path: number[] = new Array(rSeq.length);
  let equity = startingBalance;
  for (let i = 0; i < rSeq.length; i++) {
    equity *= equityMultiplierForR(rSeq[i], riskPct);
    path[i] = equity;
  }
  return path;
}

export interface RiskComparisonRow {
  riskPct: number;
  medianReturnPct: number;
  /** 95th-percentile-of-severity compounded max drawdown, as a % of that
   * simulation's own peak balance (see statistics.ts's drawdownStats doc
   * comment for the same "higher percentile = worse" convention applied
   * here via `percentile(values, 5)`). Always <= 0. */
  p95MaxDrawdownPct: number;
  probabilityPositive: number;
}

/** The one canonical risk-level list used by every Risk Comparison table/
 * chart in the Monte Carlo module (generic and, via this export, the
 * Challenge Simulator's own challengeRiskComparison.ts) - exported so
 * there is exactly one place this list is defined, never a second literal
 * copy drifting out of sync. */
export const RISK_LEVELS_PCT = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

/**
 * Re-applies EACH risk level to the SAME retained R sequences (see
 * types.ts's MonteCarloRawResult.retainedRSequences doc comment) - this is
 * what "using the SAME underlying simulated R sequences where practical"
 * means: the seven rows differ only in position size, never in which
 * trades happened or in what order, so this table visualizes position
 * sizing's effect on the distribution rather than implying risk changes
 * the strategy's own R expectancy (which it never does).
 */
export function riskComparison(retainedRSequences: number[][], startingBalance = 100): RiskComparisonRow[] {
  return RISK_LEVELS_PCT.map((riskPct) => {
    const finalReturnsPct: number[] = [];
    const maxDrawdownPct: number[] = [];
    for (const rSeq of retainedRSequences) {
      let equity = startingBalance;
      let peak = startingBalance;
      let worstDrawdownPct = 0;
      for (const r of rSeq) {
        equity *= equityMultiplierForR(r, riskPct);
        if (equity > peak) peak = equity;
        const drawdownPct = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
        if (drawdownPct < worstDrawdownPct) worstDrawdownPct = drawdownPct;
      }
      finalReturnsPct.push(((equity - startingBalance) / startingBalance) * 100);
      maxDrawdownPct.push(worstDrawdownPct);
    }
    return {
      riskPct,
      medianReturnPct: median(finalReturnsPct),
      p95MaxDrawdownPct: percentile(maxDrawdownPct, 5),
      probabilityPositive: probabilityPositive(finalReturnsPct),
    };
  });
}
