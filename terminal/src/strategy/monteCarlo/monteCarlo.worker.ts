import { runMonteCarlo } from "./engine";
import { runChallengeMonteCarlo } from "./challengeEngine";
import type { MonteCarloRawResult, SimulationRunConfig } from "./types";
import type { ChallengeRawResult, ChallengeRunConfig } from "./challengeTypes";

/**
 * A SEPARATE, isolated Web Worker from pine/pine.worker.ts - per the spec's
 * explicit "Do NOT modify or reuse the existing Pine Worker. Monte Carlo
 * Worker must be isolated from Pine indicator execution." Runs a
 * potentially long, CPU-bound simulation (up to 50,000 x 1,000 trades) off
 * the main thread so the rest of the app (chart, other panels) stays
 * responsive while it computes - same reasoning pine.worker.ts documents
 * for its own 100k-bar interpreter runs, just a fully independent worker
 * instance/module so the two can never contend for the same thread.
 *
 * Extended (not replaced) for the Challenge Simulator: the SAME worker now
 * also dispatches "challenge" requests to challengeEngine.ts's
 * runChallengeMonteCarlo - per spec's "Reuse the existing Monte Carlo
 * Worker... Do NOT create another worker", rather than spinning up a
 * second worker for the Challenge Simulator. `kind` discriminates which
 * engine a request/response belongs to; the generic "generic" path is
 * otherwise byte-for-byte the same runMonteCarlo() call as before this
 * extension.
 */

export type MonteCarloWorkerRequest =
  | { requestId: number; kind: "generic"; config: SimulationRunConfig }
  | { requestId: number; kind: "challenge"; config: ChallengeRunConfig };

export interface MonteCarloWorkerProgressMessage {
  type: "progress";
  requestId: number;
  completed: number;
  total: number;
}

export type MonteCarloWorkerDoneMessage =
  | { type: "done"; requestId: number; kind: "generic"; result: MonteCarloRawResult }
  | { type: "done"; requestId: number; kind: "challenge"; result: ChallengeRawResult };

export type MonteCarloWorkerMessage = MonteCarloWorkerProgressMessage | MonteCarloWorkerDoneMessage;

/** Pure request handler, extracted from onmessage so it's directly
 * unit-testable without a real Worker/jsdom shim - same separation
 * pine.worker.ts's handleWorkerRequest already uses. `postProgress` lets a
 * test observe/count progress calls without a real postMessage channel. */
export function handleMonteCarloRequest(
  req: MonteCarloWorkerRequest,
  postProgress: (msg: MonteCarloWorkerProgressMessage) => void
): MonteCarloWorkerDoneMessage {
  const onProgress = (completed: number, total: number) => postProgress({ type: "progress", requestId: req.requestId, completed, total });

  if (req.kind === "challenge") {
    const result = runChallengeMonteCarlo(req.config, { onProgress });
    return { type: "done", requestId: req.requestId, kind: "challenge", result };
  }
  const result = runMonteCarlo(req.config, { onProgress });
  return { type: "done", requestId: req.requestId, kind: "generic", result };
}

// Guarded so this module can be imported directly in a plain Node test
// environment (to unit-test handleMonteCarloRequest without a real
// Worker/jsdom shim) without throwing on a missing `self` global - same
// guard pine.worker.ts uses for the same reason.
if (typeof self !== "undefined") {
  self.onmessage = (e: MessageEvent<MonteCarloWorkerRequest>) => {
    const worker = self as unknown as Worker;
    const done = handleMonteCarloRequest(e.data, (msg) => worker.postMessage(msg));
    worker.postMessage(done);
  };
}
