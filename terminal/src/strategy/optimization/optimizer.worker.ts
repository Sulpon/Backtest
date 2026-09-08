import { runOptimizationEngine, type OptimizationEngineInput } from "./optimizationEngine";
import type { OptimizationRunSummary } from "./types";

/**
 * A THIRD, fully isolated Web Worker - separate from both pine/pine.worker.ts
 * and monteCarlo/monteCarlo.worker.ts, per spec's explicit "must not
 * interfere with: pine.worker, monteCarlo.worker". Pine execution itself
 * never happens here - trade generation for every parameter combination
 * runs on the MAIN thread via the existing getOrComputeResult (which
 * itself already offloads to pine.worker.ts), see
 * strategy/optimization/strategyEvaluation.ts. This worker receives only
 * the ALREADY-GENERATED trade sets and runs the pure, potentially
 * CPU-heavy post-generation computation (Train/Test metrics, symbol/time
 * robustness, parameter stability, Robustness Score, Walk-Forward) off
 * the main thread, exactly like optimizationEngine.ts's own doc comment
 * describes - this file is a thin postMessage wrapper around that one
 * pure function, no new logic of its own.
 */

export interface OptimizerWorkerRequest {
  requestId: number;
  input: OptimizationEngineInput;
}

export interface OptimizerWorkerResponse {
  requestId: number;
  result: OptimizationRunSummary;
}

/** Pure request handler, extracted from onmessage so it's directly
 * unit-testable without a real Worker/jsdom shim - same separation
 * pine.worker.ts/monteCarlo.worker.ts already use. */
export function handleOptimizerRequest(req: OptimizerWorkerRequest): OptimizerWorkerResponse {
  return { requestId: req.requestId, result: runOptimizationEngine(req.input) };
}

// Guarded so this module can be imported directly in a plain Node test
// environment without throwing on a missing `self` global - same guard
// pine.worker.ts/monteCarlo.worker.ts use for the same reason.
if (typeof self !== "undefined") {
  self.onmessage = (e: MessageEvent<OptimizerWorkerRequest>) => {
    const worker = self as unknown as Worker;
    worker.postMessage(handleOptimizerRequest(e.data));
  };
}
