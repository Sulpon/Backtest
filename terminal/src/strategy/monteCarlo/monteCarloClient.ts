import type { MonteCarloWorkerDoneMessage, MonteCarloWorkerMessage, MonteCarloWorkerRequest } from "./monteCarlo.worker";
import type { MonteCarloRawResult, SimulationRunConfig } from "./types";
import type { ChallengeRawResult, ChallengeRunConfig } from "./challengeTypes";

/**
 * Main-thread side of the isolated Monte Carlo worker - mirrors
 * pine/usePineIndicators.ts's own getWorker()/runOnWorker() shared-worker
 * pattern (lazy singleton, requestId-keyed pending map), but talks to
 * monteCarlo.worker.ts, a completely separate Worker instance/module (see
 * that file's own doc comment on why it must never be pine.worker.ts).
 *
 * Extended (not duplicated) for the Challenge Simulator: the SAME shared
 * worker singleton now also carries "challenge" requests - see
 * runChallengeMonteCarloOnWorker below - rather than a second Worker
 * instance, per spec's "Do NOT create another worker".
 */
let sharedWorker: Worker | null = null;
let nextRequestId = 1;
const pendingDone = new Map<number, (msg: MonteCarloWorkerDoneMessage) => void>();
const pendingProgress = new Map<number, (completed: number, total: number) => void>();

function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL("./monteCarlo.worker.ts", import.meta.url), { type: "module" });
    sharedWorker.onmessage = (e: MessageEvent<MonteCarloWorkerMessage>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        pendingProgress.get(msg.requestId)?.(msg.completed, msg.total);
      } else {
        const resolve = pendingDone.get(msg.requestId);
        if (resolve) {
          pendingDone.delete(msg.requestId);
          pendingProgress.delete(msg.requestId);
          resolve(msg);
        }
      }
    };
  }
  return sharedWorker;
}

/** Runs one generic Monte Carlo simulation on the isolated worker,
 * resolving with the full raw result once complete. `onProgress`
 * (optional) is called periodically (batched inside the engine - see
 * engine.ts's PROGRESS_BATCH_SIZE) while it runs, for a "Running... X / Y
 * simulations" indicator - never used to drive a per-simulation React
 * state update. */
export function runMonteCarloOnWorker(
  config: SimulationRunConfig,
  onProgress?: (completed: number, total: number) => void
): Promise<MonteCarloRawResult> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingDone.set(requestId, (msg) => resolve((msg as Extract<MonteCarloWorkerDoneMessage, { kind: "generic" }>).result));
    if (onProgress) pendingProgress.set(requestId, onProgress);
    const req: MonteCarloWorkerRequest = { requestId, kind: "generic", config };
    getWorker().postMessage(req);
  });
}

/** Runs one Challenge Simulator batch on the SAME isolated worker as
 * runMonteCarloOnWorker above (never a second Worker instance), resolving
 * with the full raw challenge result once complete. */
export function runChallengeMonteCarloOnWorker(
  config: ChallengeRunConfig,
  onProgress?: (completed: number, total: number) => void
): Promise<ChallengeRawResult> {
  const requestId = nextRequestId++;
  return new Promise((resolve) => {
    pendingDone.set(requestId, (msg) => resolve((msg as Extract<MonteCarloWorkerDoneMessage, { kind: "challenge" }>).result));
    if (onProgress) pendingProgress.set(requestId, onProgress);
    const req: MonteCarloWorkerRequest = { requestId, kind: "challenge", config };
    getWorker().postMessage(req);
  });
}
