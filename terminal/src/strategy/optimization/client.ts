import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from "./optimizer.worker";
import type { OptimizationEngineInput } from "./optimizationEngine";
import type { OptimizationRunSummary } from "./types";

/**
 * Main-thread side of the isolated optimizer worker - mirrors
 * monteCarlo/monteCarloClient.ts's own lazy-singleton, requestId-keyed
 * pending-map pattern exactly, talking to optimizer.worker.ts (a
 * completely separate Worker instance/module from both pine.worker.ts and
 * monteCarlo.worker.ts).
 */
let sharedWorker: Worker | null = null;
let nextRequestId = 1;
const pendingDone = new Map<number, (msg: OptimizerWorkerResponse) => void>();

function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL("./optimizer.worker.ts", import.meta.url), { type: "module" });
    sharedWorker.onmessage = (e: MessageEvent<OptimizerWorkerResponse>) => {
      const resolve = pendingDone.get(e.data.requestId);
      if (resolve) {
        pendingDone.delete(e.data.requestId);
        resolve(e.data);
      }
    };
  }
  return sharedWorker;
}

/** Runs the pure post-generation scoring/ranking computation on the
 * isolated optimizer worker, resolving with the full OptimizationRunSummary
 * once complete. `input.tradesByCombo` must already contain every
 * combination's full trade set (see strategyEvaluation.ts's
 * generateTradesForGrid) - this function performs no Pine invocation of
 * its own. */
export function runOptimizationOnWorker(input: OptimizationEngineInput): Promise<OptimizationRunSummary> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingDone.set(requestId, (msg) => resolve(msg.result));
    const req: OptimizerWorkerRequest = { requestId, input };
    getWorker().postMessage(req);
  });
}
