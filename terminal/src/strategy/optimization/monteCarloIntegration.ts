import { runMonteCarloOnWorker } from "../monteCarlo/monteCarloClient";
import { aggregateResults } from "../monteCarlo/statistics";
import type { AggregatedMonteCarloStats } from "../monteCarlo/statistics";
import type { SimulationRunConfig } from "../monteCarlo/types";
import type { ScanTradeRecord } from "../types";

/**
 * Monte Carlo validation for a candidate/baseline - runs the EXISTING
 * bootstrap Monte Carlo engine (the same "My Strategy" pattern already
 * used elsewhere in this app: rHistory drawn from the candidate's own
 * trade R-values, via the existing seeded worker/RNG/statistics), never a
 * new engine, RNG, or worker. Called once for Training trades and,
 * separately, once for Test/OOS trades (per spec's "separate OOS Monte
 * Carlo run shown alongside Training Monte Carlo") - this file has no
 * opinion on which; the caller decides which trade set to pass.
 */
const DEFAULT_MC_SIMULATIONS = 5000;
const DEFAULT_MC_TRADES_PER_SIM = 250;

/** Below this many trades, a bootstrap resample is not meaningful (too few
 * distinct R-values to resample from) - "Insufficient Monte Carlo sample"
 * fallback per spec, mirroring this module's own DEFAULT_MIN_SAMPLE_SIZE
 * philosophy (metrics.ts) at a lower bar appropriate to bootstrapping
 * specifically rather than general statistical significance. */
export const MIN_MONTE_CARLO_SAMPLE = 10;

export interface CandidateMonteCarloResult {
  sufficientSample: boolean;
  sampleSize: number;
  stats: AggregatedMonteCarloStats | null;
}

export async function runCandidateMonteCarlo(
  trades: ScanTradeRecord[],
  seed: number,
  numSimulations: number = DEFAULT_MC_SIMULATIONS,
  tradesPerSimulation: number = DEFAULT_MC_TRADES_PER_SIM
): Promise<CandidateMonteCarloResult> {
  const rHistory = trades.map((t) => t.r);
  if (rHistory.length < MIN_MONTE_CARLO_SAMPLE) {
    return { sufficientSample: false, sampleSize: rHistory.length, stats: null };
  }

  const config: SimulationRunConfig = {
    numSimulations,
    tradesPerSimulation,
    seed,
    source: { kind: "bootstrap", rHistory },
  };
  const raw = await runMonteCarloOnWorker(config);
  return { sufficientSample: true, sampleSize: rHistory.length, stats: aggregateResults(raw) };
}
