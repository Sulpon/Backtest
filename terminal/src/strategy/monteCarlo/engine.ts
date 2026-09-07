import type { CustomOutcome, MonteCarloRawResult, OutcomeSource, Rng, SimulationRunConfig } from "./types";
import { createRng } from "./rng";

/**
 * Draws one simulated trade's R outcome from `source`. This is the ONLY
 * place My Strategy (bootstrap) and Strategy Lab (simple/custom) actually
 * differ - runMonteCarlo() below, and everything statistics.ts/
 * riskEquity.ts do with its output, is identical regardless of `source`,
 * per the spec's "both modes must use the SAME underlying engine".
 */
export function nextOutcomeR(source: OutcomeSource, rng: Rng): number {
  switch (source.kind) {
    case "bootstrap": {
      // Resampling WITH replacement from the actual historical R values -
      // never reduced to win-rate/avg-win/avg-loss first, per spec ("Do NOT
      // reduce the user's strategy to only Win Rate/Avg Win/Avg Loss").
      const { rHistory } = source;
      if (rHistory.length === 0) return 0;
      const idx = Math.min(rHistory.length - 1, Math.floor(rng() * rHistory.length));
      return rHistory[idx];
    }
    case "simple": {
      const { winRatePct, avgWinR, avgLossR } = source.params;
      return rng() * 100 < winRatePct ? avgWinR : -avgLossR;
    }
    case "custom": {
      const { winRatePct, wins, losses } = source.params;
      return pickWeighted(rng() * 100 < winRatePct ? wins : losses, rng);
    }
  }
}

/** Weighted pick among a win/loss branch's own outcome list - weights are
 * relative (normalized by their own sum here), matching the spec's example
 * of a win-branch summing to 100% and a loss-branch separately summing to
 * 100% (two independent distributions, not one combined pool). */
function pickWeighted(outcomes: CustomOutcome[], rng: Rng): number {
  if (outcomes.length === 0) return 0;
  const total = outcomes.reduce((sum, o) => sum + o.probabilityPct, 0);
  if (total <= 0) return outcomes[0].r;
  let roll = rng() * total;
  for (const o of outcomes) {
    roll -= o.probabilityPct;
    if (roll <= 0) return o.r;
  }
  return outcomes[outcomes.length - 1].r;
}

/** Longest run of positive-R outcomes in sequence order. A standalone,
 * directly-testable function (see engine.test.ts's WIN/LOSS-sequence
 * cases) - runMonteCarlo's hot loop below calls this once per completed
 * simulation's full R sequence rather than re-deriving the same logic
 * inline, so there is exactly one implementation of "what counts as a
 * streak" to get right. */
export function longestWinStreak(rSeq: readonly number[]): number {
  let current = 0;
  let max = 0;
  for (const r of rSeq) {
    if (r > 0) {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/** Mirrors longestWinStreak exactly, for negative-R outcomes. */
export function longestLoseStreak(rSeq: readonly number[]): number {
  let current = 0;
  let max = 0;
  for (const r of rSeq) {
    if (r < 0) {
      current += 1;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

export interface SequenceStats {
  finalR: number;
  maxDrawdownR: number;
  maxWinningStreak: number;
  maxLosingStreak: number;
  peakR: number;
  minimumEquityR: number;
  /** Cumulative-R equity value after each trade, same length as `rSeq`. */
  equityPath: number[];
}

/**
 * Pure equity/drawdown/streak math for one already-generated R sequence -
 * used both by runMonteCarlo's hot loop below (so there is exactly one
 * implementation of this arithmetic) and directly by engine.test.ts's
 * DRAWDOWN/STREAK test cases (which check exact fixed sequences like
 * [+3,+2,-1,-4,+2,-5] -> -8R against the spec's own worked examples).
 * Equity starts at 0R, per spec ("Do NOT assume account balance for the
 * core R calculation").
 */
export function statsFromRSequence(rSeq: readonly number[]): SequenceStats {
  const equityPath: number[] = new Array(rSeq.length);
  let equity = 0;
  let peak = 0;
  let worstDrawdown = 0;
  let minEquity = 0;
  for (let t = 0; t < rSeq.length; t++) {
    equity += rSeq[t];
    if (equity > peak) peak = equity;
    const drawdown = equity - peak;
    if (drawdown < worstDrawdown) worstDrawdown = drawdown;
    if (equity < minEquity) minEquity = equity;
    equityPath[t] = equity;
  }
  return {
    finalR: equity,
    maxDrawdownR: worstDrawdown,
    maxWinningStreak: longestWinStreak(rSeq),
    maxLosingStreak: longestLoseStreak(rSeq),
    peakR: peak,
    minimumEquityR: minEquity,
    equityPath,
  };
}

/** `count` indices spread as evenly as possible across [0, rangeLength-1],
 * always including the last index (0 when rangeLength<=0). Used both for
 * picking which simulations become "representative paths" and which trade
 * indices become equity-envelope checkpoints - the same even-sampling
 * concept in both places. De-duplicated (a `count` >= `rangeLength` just
 * yields every index once, not repeats). */
export function evenlySpacedIndices(rangeLength: number, count: number): number[] {
  if (rangeLength <= 0) return [];
  const n = Math.max(1, Math.min(count, rangeLength));
  if (n === 1) return [rangeLength - 1];
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(rangeLength - 1, Math.round((i * (rangeLength - 1)) / (n - 1)));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/** Checkpoints for the equity-percentile-envelope chart - bounded
 * regardless of tradesPerSimulation, so memory for `checkpointEquity`
 * (rows x numSimulations) never scales with trade count. */
const EQUITY_CHECKPOINTS = 100;
/** "~50-100 representative paths", per spec - never "thousands". */
const REPRESENTATIVE_PATH_COUNT = 80;
/** Bounds Risk Comparison's per-trade-R-sequence retention (see
 * types.ts's MonteCarloRawResult doc comment) - large enough for a stable
 * percentile estimate, small enough that memory never scales with
 * numSimulations at the spec's stated 50,000-simulation ceiling. */
const RETAINED_R_SEQUENCE_CAP = 2000;
/** How often runMonteCarlo reports progress via its optional callback -
 * batched rather than once per simulation, so a 50,000-simulation run
 * doesn't post 50,000 progress updates (see this module's "process
 * simulations in batches" requirement). */
const PROGRESS_BATCH_SIZE = 500;

export interface RunMonteCarloOptions {
  onProgress?: (completed: number, total: number) => void;
}

/**
 * The one simulation loop shared by both My Strategy and Strategy Lab -
 * everything after `nextOutcomeR` is identical regardless of `config.
 * source`. Pure function (no DOM, no store access) so it's directly
 * unit-testable (engine.test.ts) and safe to run inside a Web Worker
 * unchanged (monteCarlo.worker.ts just calls this).
 *
 * Deliberately allocates one small transient `rSeq`/`equityPath` pair per
 * simulation (via statsFromRSequence) rather than one giant `numSimulations
 * x tradesPerSimulation` matrix - at the spec's worst case (50,000 x 1,000)
 * that matrix would be 50M floats (400MB) alive at once; each iteration's
 * arrays are garbage almost immediately after this loop extracts what it
 * needs into the bounded structures described in types.ts's
 * MonteCarloRawResult doc comment (only `representativePaths`/
 * `retainedRSequences` actually keep a reference beyond their own
 * iteration, and both are capped independent of `numSimulations`).
 */
export function runMonteCarlo(config: SimulationRunConfig, options: RunMonteCarloOptions = {}): MonteCarloRawResult {
  const { numSimulations, tradesPerSimulation, seed, source } = config;
  const rng = createRng(seed);

  const finalR = new Float64Array(numSimulations);
  const maxDrawdownR = new Float64Array(numSimulations);
  const maxWinningStreak = new Float64Array(numSimulations);
  const maxLosingStreak = new Float64Array(numSimulations);
  const peakR = new Float64Array(numSimulations);
  const minimumEquityR = new Float64Array(numSimulations);

  const checkpointTradeIndex = evenlySpacedIndices(tradesPerSimulation, EQUITY_CHECKPOINTS);
  const checkpointEquity = checkpointTradeIndex.map(() => new Float64Array(numSimulations));

  const representativeSimIndices = new Set(evenlySpacedIndices(numSimulations, REPRESENTATIVE_PATH_COUNT));
  const representativePaths: number[][] = [];

  const retainedCap = Math.min(RETAINED_R_SEQUENCE_CAP, numSimulations);
  const retainStride = Math.max(1, Math.floor(numSimulations / Math.max(1, retainedCap)));
  const retainedRSequences: number[][] = [];

  for (let i = 0; i < numSimulations; i++) {
    const rSeq: number[] = new Array(tradesPerSimulation);
    for (let t = 0; t < tradesPerSimulation; t++) rSeq[t] = nextOutcomeR(source, rng);

    const stats = statsFromRSequence(rSeq);
    finalR[i] = stats.finalR;
    maxDrawdownR[i] = stats.maxDrawdownR;
    maxWinningStreak[i] = stats.maxWinningStreak;
    maxLosingStreak[i] = stats.maxLosingStreak;
    peakR[i] = stats.peakR;
    minimumEquityR[i] = stats.minimumEquityR;

    for (let row = 0; row < checkpointTradeIndex.length; row++) {
      checkpointEquity[row][i] = stats.equityPath[checkpointTradeIndex[row]];
    }
    if (representativeSimIndices.has(i)) representativePaths.push(stats.equityPath);
    if (retainedRSequences.length < retainedCap && i % retainStride === 0) retainedRSequences.push(rSeq);

    if (options.onProgress && ((i + 1) % PROGRESS_BATCH_SIZE === 0 || i === numSimulations - 1)) {
      options.onProgress(i + 1, numSimulations);
    }
  }

  return {
    seed,
    numSimulations,
    tradesPerSimulation,
    finalR,
    maxDrawdownR,
    maxWinningStreak,
    maxLosingStreak,
    peakR,
    minimumEquityR,
    checkpointTradeIndex,
    checkpointEquity,
    representativePaths,
    retainedRSequences,
  };
}
