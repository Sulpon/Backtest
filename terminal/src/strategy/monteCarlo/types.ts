/**
 * Shared types for the Monte Carlo module - a read-only analysis layer on
 * top of the existing Strategy Scan trade records (strategy/types.ts's
 * ScanTradeRecord) and, in Strategy Lab mode, a purely hypothetical
 * Win-Rate/RR model. Nothing here generates, mutates, or stores a
 * ScanTradeRecord - see historicalStats.ts for the one place this module
 * reads them (via dateAnalytics.ts's existing filterTrades/computeKpis,
 * never a second filtering/stat implementation).
 */

/** [0, 1) - the engine's only randomness source. Never Math.random()
 * directly anywhere in this module; always produced by rng.ts's
 * createRng(seed) so a given seed + inputs reproduce identically. */
export type Rng = () => number;

/** Per-simulation summary, computed once each full trade sequence has run.
 * `finalR`/`maxDrawdownR`/streaks/`peakR`/`minimumEquityR` are all in
 * R-space (never account currency) - see riskEquity.ts for the separate
 * layer that converts an R-sequence into a risk-sized % or currency
 * equity path. */
export interface EngineTradeStats {
  finalR: number;
  /** <= 0. Most negative point of (cumulative equity - running peak). */
  maxDrawdownR: number;
  maxWinningStreak: number;
  maxLosingStreak: number;
  peakR: number;
  /** Most negative point the cumulative-R equity curve itself reached
   * (can be positive if the curve never dipped below its starting 0). */
  minimumEquityR: number;
  tradesSimulated: number;
}

/** Strategy Lab's "Simple" outcome model (the mandatory default - see
 * this module's CustomDistributionParams for the optional advanced one). */
export interface SimpleLabParams {
  /** 0-100. */
  winRatePct: number;
  /** > 0 (R multiple of a winning trade). */
  avgWinR: number;
  /** > 0 (magnitude - the loss is applied as -avgLossR). */
  avgLossR: number;
}

/** One possible outcome magnitude and its relative probability within its
 * own win/loss branch (see CustomDistributionParams's doc comment for why
 * wins and losses are normalized separately, not as one combined 100%). */
export interface CustomOutcome {
  r: number;
  /** Relative weight within `wins` or `losses` - normalized internally by
   * engine.ts's pickWeighted, so these don't strictly need to sum to 100
   * (they're treated as relative weights), matching the spec's own example
   * of win-branch probabilities summing to 100% and the loss branch
   * separately summing to 100%. */
  probabilityPct: number;
}

/** Strategy Lab's optional advanced outcome model: win/loss is still
 * decided by `winRatePct` (exactly like SimpleLabParams), but the
 * magnitude of a win or loss is then drawn from its own weighted outcome
 * list instead of a single fixed avgWin/avgLoss value. */
export interface CustomDistributionParams {
  winRatePct: number;
  /** r > 0 for every entry. */
  wins: CustomOutcome[];
  /** r < 0 for every entry. */
  losses: CustomOutcome[];
}

/** Where a simulated trade's R outcome comes from - the one thing that
 * actually differs between My Strategy (bootstrap) and Strategy Lab
 * (simple/custom); everything downstream of a generated R value (equity,
 * drawdown, streaks, statistics, risk conversion) is identical for all
 * three, per the spec's "both modes must use the SAME underlying engine". */
export type OutcomeSource =
  | { kind: "bootstrap"; rHistory: number[] }
  | { kind: "simple"; params: SimpleLabParams }
  | { kind: "custom"; params: CustomDistributionParams };

export interface SimulationRunConfig {
  numSimulations: number;
  tradesPerSimulation: number;
  seed: number;
  source: OutcomeSource;
}

/**
 * Full output of runMonteCarlo() - deliberately NOT "one array of
 * per-simulation result objects": at the spec's stated worst case
 * (50,000 sims x 1,000 trades), keeping a full equity path for every
 * simulation would mean tens of millions of floats retained live. Instead:
 *  - per-simulation SUMMARY stats live in typed arrays (cheap: one float
 *    per simulation per metric).
 *  - the equity-percentile-envelope chart only ever needs equity value at
 *    a bounded number of checkpoint trade-indices (~100), not the full
 *    path, across ALL simulations - `checkpointEquity`.
 *  - the equity-curve chart only renders ~50-100 individual paths (never
 *    "thousands", per spec) - `representativePaths` holds exactly those,
 *    evenly sampled across the simulation run.
 *  - Risk Comparison needs full per-trade R sequences (compounding is
 *    order-dependent, so summary stats alone aren't enough) but only for a
 *    bounded, evenly-sampled subset of simulations - `retainedRSequences` -
 *    per this module's "reuse the same simulated R sequences where
 *    practical" mandate; retaining a representative sample rather than
 *    every one of up to 50,000 sequences is what keeps that practical.
 */
export interface MonteCarloRawResult {
  seed: number;
  numSimulations: number;
  tradesPerSimulation: number;
  finalR: Float64Array;
  maxDrawdownR: Float64Array;
  maxWinningStreak: Float64Array;
  maxLosingStreak: Float64Array;
  peakR: Float64Array;
  minimumEquityR: Float64Array;
  /** Trade index (0-based) each row of `checkpointEquity` was sampled at -
   * always includes the final trade index so "final equity" is always one
   * of the envelope's own points. */
  checkpointTradeIndex: number[];
  /** checkpointEquity[row][simIndex] - cumulative-R equity of that
   * simulation at checkpointTradeIndex[row]. */
  checkpointEquity: Float64Array[];
  /** Full per-trade cumulative-R equity path for ~50-100 simulations,
   * evenly sampled across the run - for the equity-curve chart's
   * individual "representative paths" only, never for statistics (every
   * statistic is computed from the full `numSimulations`, not this
   * subset). */
  representativePaths: number[][];
  /** Full per-trade R sequences for a bounded, evenly-sampled subset of
   * simulations (see this interface's own doc comment) - Risk Comparison's
   * only input besides the risk levels themselves. */
  retainedRSequences: number[][];
}

export type MonteCarloMode = "myStrategy" | "strategyLab" | "challenge";

export type OutcomeModel = "simple" | "custom";
