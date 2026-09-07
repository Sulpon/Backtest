import { createRng } from "./rng";
import { nextOutcomeR } from "./engine";
import { equityMultiplierForR } from "./riskEquity";
import { mean, median } from "./statistics";
import type { OutcomeSource } from "./types";
import type { SensitivityCellStats, SensitivityMatrixResult, SensitivityRunConfig } from "./sensitivityTypes";

/**
 * Risk x Reward/Risk Sensitivity Matrix engine - built entirely on
 * existing primitives, never a second engine/RNG/outcome model:
 *  - engine.ts's nextOutcomeR (the SAME "simple" Win-Rate/Avg-Win/Avg-Loss
 *    outcome model Strategy Lab already uses) generates every trade.
 *  - rng.ts's createRng is the ONLY RNG instance for a whole matrix run -
 *    never reseeded per cell (see this file's own "common random numbers"
 *    section below for exactly how the single stream is shared).
 *  - riskEquity.ts's equityMultiplierForR is the ONLY risk-sizing
 *    calculation used to turn an R outcome into an equity change.
 *  - statistics.ts's mean/median are the only aggregation functions used.
 *
 * OUTCOME MODEL FOR THIS MATRIX (per spec): for a given cell, Average Win R
 * = that cell's own Reward:Risk column value, and Average Loss R is always
 * exactly 1 - not necessarily equal to whatever Strategy Lab's own "Average
 * Loss" field currently holds. This is not a discrepancy: "Reward:Risk"
 * is BY DEFINITION reward measured in units of risk (1R), so this matrix's
 * two axes (Risk % and Reward:Risk) are only meaningful under that
 * convention. Win Rate is the one Strategy Lab value actually reused as-is
 * (see sensitivityTypes.ts's SensitivityRunConfig doc comment).
 *
 * COMMON RANDOM NUMBERS (per spec's "prefer common random numbers if
 * practical"): whether a trade is a WIN or a LOSS depends only on Win Rate,
 * never on Risk % or Reward:Risk - so the exact same underlying stream of
 * WIN/LOSS decisions is valid for EVERY cell in the whole matrix, row or
 * column. This function exploits that twice:
 *  (a) ACROSS RR COLUMNS - `createRng(seed)` is re-created with the SAME
 *      seed at the start of every column's loop (not continued from the
 *      previous column), so column 1 and column 2 draw byte-for-byte the
 *      same sequence of raw rng() values. Since nextOutcomeR's "simple"
 *      branch decides win-vs-loss purely from `rng()*100 < winRatePct`
 *      (winRatePct is the same for the whole matrix), every column ends up
 *      with the IDENTICAL win/loss pattern at each (simulation, trade)
 *      position - only the magnitude assigned to a win (that column's own
 *      `rr`) differs. This isolates the effect of changing Reward:Risk
 *      from pure sampling noise.
 *  (b) ACROSS RISK ROWS - each column draws its `numSimulations` R
 *      sequences from the RNG exactly ONCE, computes that sequence's
 *      R-space statistics (final R, max drawdown R - both risk-size-
 *      agnostic, per riskEquity.ts's own doc comment that "position sizing
 *      doesn't change a strategy's expectancy in R"), and then REPLAYS the
 *      identical stored sequences once per risk row to compute only the
 *      risk-size-dependent statistics (probability of profit, mean final
 *      equity multiplier) - no further RNG draws for the risk-row replay
 *      passes.
 * Together, (a)+(b) mean the whole matrix's true RNG draw count is only
 * (RR ratios x simulations x trades) - independent of how many risk rows
 * exist - while every cell in the matrix is comparable against every other
 * cell on the same underlying random outcomes, the strongest form of
 * "common random numbers" practical here.
 *
 * MEMORY: R sequences for one RR column (numSimulations x
 * tradesPerSimulation numbers) are held only for the duration of
 * processing that column's risk rows, then discarded before the next
 * column starts - peak memory is therefore independent of how many RR
 * columns or risk rows exist, only of numSimulations x tradesPerSimulation
 * (e.g. 10,000 x 100 = 1,000,000 floats = 8MB, regardless of a 15x6=90
 * cell matrix).
 */

export interface RunSensitivityMatrixOptions {
  onProgress?: (completed: number, total: number) => void;
}

export function runSensitivityMatrix(config: SensitivityRunConfig, options: RunSensitivityMatrixOptions = {}): SensitivityMatrixResult {
  const { winRatePct, tradesPerSimulation, numSimulations, seed, startingBalance, axes } = config;
  const { riskLevelsPct, rewardRiskRatios } = axes;

  const cells: SensitivityCellStats[][] = riskLevelsPct.map(() => new Array(rewardRiskRatios.length));
  const totalCells = riskLevelsPct.length * rewardRiskRatios.length;
  let completedCells = 0;

  for (let colIdx = 0; colIdx < rewardRiskRatios.length; colIdx++) {
    const rr = rewardRiskRatios[colIdx];
    // Average Loss R is always 1 here - see this module's own doc comment.
    const source: OutcomeSource = { kind: "simple", params: { winRatePct, avgWinR: rr, avgLossR: 1 } };
    // Reset to the SAME seed for every column - see this module's own
    // "common random numbers" doc comment for why this is deliberate.
    const rng = createRng(seed);

    // Draw every simulation's R sequence for this column ONCE - common
    // random numbers, reused by every risk row below.
    const rSequences: Float64Array[] = new Array(numSimulations);
    const finalRs = new Float64Array(numSimulations);
    const maxDrawdownRs = new Float64Array(numSimulations);

    for (let i = 0; i < numSimulations; i++) {
      const seq = new Float64Array(tradesPerSimulation);
      let sumR = 0;
      let peakR = 0;
      let worstDD = 0;
      for (let t = 0; t < tradesPerSimulation; t++) {
        const r = nextOutcomeR(source, rng);
        seq[t] = r;
        sumR += r;
        if (sumR > peakR) peakR = sumR;
        const dd = sumR - peakR;
        if (dd < worstDD) worstDD = dd;
      }
      rSequences[i] = seq;
      finalRs[i] = sumR;
      maxDrawdownRs[i] = worstDD;
    }

    // Risk-size-agnostic stats for this RR column - identical across every
    // risk row (see this module's own doc comment).
    const meanFinalR = mean(finalRs);
    const medianFinalR = median(finalRs);
    const medianMaxDrawdownR = median(maxDrawdownRs);

    for (let rowIdx = 0; rowIdx < riskLevelsPct.length; rowIdx++) {
      const riskPct = riskLevelsPct[rowIdx];
      let profitCount = 0;
      let sumEquityMultiplier = 0;

      for (let i = 0; i < numSimulations; i++) {
        const seq = rSequences[i];
        let equityMultiplier = 1;
        for (let t = 0; t < tradesPerSimulation; t++) {
          equityMultiplier *= equityMultiplierForR(seq[t], riskPct);
        }
        if (equityMultiplier > 1) profitCount++;
        sumEquityMultiplier += equityMultiplier;
      }

      cells[rowIdx][colIdx] = {
        riskPct,
        rr,
        probabilityOfProfitPct: (profitCount / numSimulations) * 100,
        meanFinalR,
        medianFinalR,
        medianMaxDrawdownR,
        meanFinalEquityMultiplier: sumEquityMultiplier / numSimulations,
      };

      completedCells++;
      if (options.onProgress) options.onProgress(completedCells, totalCells);
    }
  }

  return {
    seed,
    winRatePct,
    tradesPerSimulation,
    numSimulations,
    startingBalance,
    riskLevelsPct,
    rewardRiskRatios,
    cells,
  };
}
