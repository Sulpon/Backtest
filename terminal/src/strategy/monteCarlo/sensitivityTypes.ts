/**
 * Types for the Risk x Reward/Risk Sensitivity Matrix - built entirely on
 * top of the existing Simple outcome model (engine.ts's nextOutcomeR),
 * seeded RNG (rng.ts's createRng), and risk/equity layer (riskEquity.ts's
 * equityMultiplierForR). No second engine, no second RNG - see
 * sensitivityEngine.ts's own module doc comment for exactly how each
 * existing primitive is reused.
 */

export interface SensitivityAxes {
  /** Rows - percentages, e.g. [0.25, 0.5, ..., 3.75]. */
  riskLevelsPct: number[];
  /** Columns - reward:risk ratios, e.g. [0.25, 0.5, 1, 1.5, 2, 3]. */
  rewardRiskRatios: number[];
}

export interface SensitivityRunConfig {
  /** The Simple model's win rate - the ONE Strategy Lab input this matrix
   * reuses directly. Average Win/Loss are NOT reused - see
   * sensitivityEngine.ts's doc comment for why Average Loss is always 1R
   * here (it's what "Reward:Risk ratio" is defined against). */
  winRatePct: number;
  tradesPerSimulation: number;
  numSimulations: number;
  seed: number;
  /** null = no dollar figure available; per-cell dollar stats (mean final
   * equity) are then omitted rather than fabricated. */
  startingBalance: number | null;
  axes: SensitivityAxes;
}

export interface SensitivityCellStats {
  riskPct: number;
  rr: number;
  /** % of simulations ending with final equity > starting equity
   * (equivalently, compounded equity multiplier > 1) - per spec, NEVER
   * "probability of avoiding drawdown" or any challenge/pass-fail concept. */
  probabilityOfProfitPct: number;
  /** Simulated MEAN final R across all simulations in this cell - see
   * sensitivityEngine.ts's doc comment on why this is identical for every
   * risk level within the same RR column (R-space is risk-size-agnostic
   * by this app's own established convention - riskEquity.ts's module doc
   * comment). This is the SIMULATED statistic, not the theoretical
   * EV x trades closed form (that's shown separately, alongside this, in
   * the click-through detail panel via labMath.ts's expectedValueR - see
   * SensitivityMatrix.tsx). */
  meanFinalR: number;
  medianFinalR: number;
  /** Median of the per-simulation max drawdown, in R (always <= 0) - also
   * risk-size-agnostic within an RR column, same reasoning as meanFinalR. */
  medianMaxDrawdownR: number;
  /** Mean compounded final-equity MULTIPLIER (1.0 = breakeven) - THIS one
   * DOES vary by risk level (compounding is risk-size-dependent). Combined
   * with `startingBalance` by the UI to show a dollar figure; kept as a
   * multiplier here so the engine stays balance-agnostic. */
  meanFinalEquityMultiplier: number;
}

export interface SensitivityMatrixResult {
  seed: number;
  winRatePct: number;
  tradesPerSimulation: number;
  numSimulations: number;
  startingBalance: number | null;
  riskLevelsPct: number[];
  rewardRiskRatios: number[];
  /** cells[riskRowIndex][rrColIndex]. */
  cells: SensitivityCellStats[][];
}

export const DEFAULT_SENSITIVITY_RISK_LEVELS_PCT = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75];
export const SENSITIVITY_RISK_PRESET_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 5];

export const DEFAULT_SENSITIVITY_RR_RATIOS = [0.25, 0.5, 1, 1.5, 2, 3];
export const SENSITIVITY_RR_PRESET_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
