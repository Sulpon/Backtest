import type { ScanTradeRecord } from "../types";

/**
 * Strategy Optimization - types shared across the whole module. This is an
 * ANALYSIS LAYER on top of the existing Strategy Scan (ScanTradeRecord)
 * and Monte Carlo systems, never a second trade-generation or simulation
 * engine - see strategyEvaluation.ts for the one place Pine is actually
 * invoked (via the existing getOrComputeResult), and optimizationEngine.ts
 * for the pure, trade-data-only scoring logic.
 */

// ---- Parameter space ----

export interface ParameterDef {
  /** The exact Pine input() variable name - see interpreter.ts's InputDef.
   * This is also the key used in PineIndicator.inputOverrides. */
  key: string;
  /** Human-readable label (InputDef.title, or `key` if the script didn't
   * give one). */
  label: string;
  current: number;
  min: number;
  max: number;
  step: number;
}

/** One point in parameter space - `values[def.key] = number` for every
 * configured ParameterDef, always including the exact `current` value as
 * its own combination (see parameterSpace.ts's withBaseline). */
export interface ParameterCombination {
  /** Deterministic, order-independent string key - see parameterSpace.ts's
   * combinationKey(). Used for caching, the cell-click heatmap lookup, and
   * de-duplicating the baseline against a grid point that happens to equal
   * it exactly. */
  key: string;
  values: Record<string, number>;
  isBaseline: boolean;
}

// ---- Trade splitting ----

export interface DateRange {
  /** Unix seconds, inclusive. */
  fromSec: number;
  toSec: number;
}

/** A chronological train/test boundary - see trainTestSplit.ts. Trades are
 * assigned by exitTime, NEVER entryTime (this module's own global rule,
 * inherited from dateAnalytics.ts's - see that file's own doc comment). */
export interface TrainTestSplitConfig {
  /** 50, 60, 70, or 80 - % of the date range allocated to Train. */
  trainPct: 50 | 60 | 70 | 80;
}

export interface SplitTrades {
  train: ScanTradeRecord[];
  test: ScanTradeRecord[];
  trainRange: DateRange;
  testRange: DateRange;
}

// ---- Metrics ----

export interface CandidateMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgTradeR: number;
  expectedValue: number;
  /** sum(winning R) / abs(sum(losing R)) - null when there are no losing
   * trades (undefined/infinite ratio - never fabricated as Infinity). */
  profitFactor: number | null;
  maxDrawdownR: number;
  maxWinningStreak: number;
  maxLosingStreak: number;
  avgTradesPerDay: number;
  avgTradesPerWeek: number;
  avgTradesPerMonth: number;
  avgTradesPerYear: number;
  bestDay: { dateKey: string; totalRR: number } | null;
  worstDay: { dateKey: string; totalRR: number } | null;
  /** Below the configured MIN_TRADES threshold - see optimizationEngine.ts.
   * Such candidates are labeled "Insufficient sample" and structurally
   * excluded from top-candidate ranking, never score-boosted. */
  insufficientSample: boolean;
}

// ---- Symbol / time robustness ----

export interface SymbolBreakdownRow {
  symbol: string;
  trades: number;
  totalR: number;
  winRate: number;
}

export interface SymbolRobustnessResult {
  bySymbol: SymbolBreakdownRow[];
  profitableSymbolsPct: number;
  medianSymbolR: number;
  worstSymbolR: number;
  bestSymbolR: number;
  /** Coefficient of variation (stdev/|mean|) of per-symbol total R - higher
   * means less consistent across symbols. null when fewer than 2 symbols
   * have trades (dispersion is undefined for a single sample). */
  dispersion: number | null;
}

export interface TimeBreakdownRow {
  key: string; // "YYYY" or "YYYY-MM"
  trades: number;
  winRate: number;
  expectedValue: number;
  totalR: number;
  maxDrawdownR: number;
}

export interface TimeRobustnessResult {
  byYear: TimeBreakdownRow[];
  byMonth: TimeBreakdownRow[];
  /** True when one single year accounts for a disproportionate share of
   * total R - see timeRobustness.ts's own documented threshold. */
  concentratedInOneYear: boolean;
}

// ---- Parameter stability ----

export interface StabilityResult {
  comboKey: string;
  /** Mean training score of this point's immediate grid neighbors (points
   * differing by exactly one step in exactly one parameter). null when the
   * point has no neighbors in the searched grid (e.g. a single-parameter
   * grid with only one value). */
  neighborAvgScore: number | null;
  /** (own score - neighborAvgScore) / max(1, |neighborAvgScore|) - large
   * positive values mean an isolated spike far above its neighbors; see
   * stability.ts's own doc comment for the exact formula and threshold. */
  isolationRatio: number | null;
  isIsolatedPeak: boolean;
}

export interface RobustRegion {
  /** One inclusive [min,max] range per searched parameter, describing the
   * contiguous plateau of near-peak scores this candidate sits inside. */
  ranges: Record<string, { min: number; max: number }>;
}

// ---- Robustness score ----

export interface RobustnessScoreBreakdown {
  /** Every sub-score is normalized to [0,1] - see robustness.ts's own doc
   * comment for the exact formula of each. */
  evScore: number;
  totalRScore: number;
  drawdownScore: number;
  sampleSizeScore: number;
  symbolConsistencyScore: number;
  timeConsistencyScore: number;
  parameterStabilityScore: number;
  /** Weighted sum of the above, in [0,100] for display. */
  total: number;
}

// ---- Warnings ----

export type WarningSeverity = "low" | "medium" | "high";

export interface OverfitWarning {
  severity: WarningSeverity;
  message: string;
}

// ---- Walk-forward ----

export interface WalkForwardFoldConfig {
  trainRange: DateRange;
  testRange: DateRange;
}

export interface WalkForwardFoldResult {
  foldIndex: number;
  trainRange: DateRange;
  testRange: DateRange;
  selectedParams: Record<string, number>;
  trainMetrics: CandidateMetrics;
  testMetrics: CandidateMetrics;
}

export interface WalkForwardSummary {
  folds: WalkForwardFoldResult[];
  oosTotalR: number;
  oosExpectedValue: number;
  oosWinRate: number;
  oosMaxDrawdownR: number;
  profitableFolds: number;
  totalFolds: number;
  /** % of folds with test-period total R > 0. */
  oosConsistencyPct: number;
}

// ---- Candidate (one parameter combination's full evaluation) ----

export interface CandidateResult {
  combination: ParameterCombination;
  trainMetrics: CandidateMetrics;
  testMetrics: CandidateMetrics;
  symbolRobustness: SymbolRobustnessResult;
  timeRobustness: TimeRobustnessResult;
  stability: StabilityResult;
  robustness: RobustnessScoreBreakdown;
  warnings: OverfitWarning[];
  /** Train EV -> Test EV % degradation - see trainTestSplit.ts's
   * computeDegradation(). null when Train EV is 0 (division undefined). */
  evDegradationPct: number | null;
  totalRDegradationPct: number | null;
}

export type OptimizationObjective = "robustness" | "oosEv" | "oosTotalR" | "riskAdjusted";

export interface OptimizationRunSummary {
  baseline: CandidateResult;
  candidates: CandidateResult[];
  /** candidates, sorted by the selected objective - see ranking.ts. */
  ranked: CandidateResult[];
  robustRegion: RobustRegion | null;
  walkForward: WalkForwardSummary | null;
  combinationsTested: number;
  validCandidates: number;
  insufficientSampleCount: number;
}
