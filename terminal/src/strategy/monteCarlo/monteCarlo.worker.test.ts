import { describe, expect, it } from "vitest";
import { handleMonteCarloRequest, type MonteCarloWorkerProgressMessage } from "./monteCarlo.worker";
import type { SimulationRunConfig } from "./types";
import type { ChallengeConfig, ChallengeRunConfig } from "./challengeTypes";
import type { SensitivityRunConfig } from "./sensitivityTypes";

/**
 * Regression tests for monteCarlo.worker.ts's handleMonteCarloRequest - the
 * pure request -> response logic extracted from onmessage, same separation
 * pine.worker.ts's own handleWorkerRequest uses (see that file's test for
 * the same reasoning). Runs entirely off runMonteCarlo/runChallengeMonteCarlo
 * (engine.test.ts/challengeEngine.test.ts cover those functions' own
 * correctness in depth) - this file only checks the worker-message
 * plumbing itself: requestId/kind passthrough and batched progress
 * reporting, for BOTH request kinds now that the protocol is extended.
 */

function genericConfig(overrides: Partial<SimulationRunConfig> = {}): SimulationRunConfig {
  return {
    numSimulations: 20,
    tradesPerSimulation: 10,
    seed: 1,
    source: { kind: "simple", params: { winRatePct: 50, avgWinR: 1, avgLossR: 1 } },
    ...overrides,
  };
}

function challengeConfig(overrides: Partial<ChallengeRunConfig> = {}): ChallengeRunConfig {
  const challenge: ChallengeConfig = {
    challengeType: "single",
    phase1: { profitTargetPct: 8, maxDrawdownPct: 10 },
    phase2: null,
    drawdownType: "initial",
    dailyDrawdownPct: null,
    profitSplitPct: 80,
    challengeFee: 500,
  };
  return {
    numSimulations: 20,
    tradesPerPhaseCap: 10,
    seed: 1,
    source: { kind: "simple", params: { winRatePct: 50, avgWinR: 1, avgLossR: 1 } },
    riskPct: 1,
    accountSize: 100000,
    challenge,
    tradesPerDay: null,
    ...overrides,
  };
}

describe("handleMonteCarloRequest - generic", () => {
  it("returns a done message carrying the requestId, kind, and a full raw result", () => {
    const progress: MonteCarloWorkerProgressMessage[] = [];
    const done = handleMonteCarloRequest({ requestId: 42, kind: "generic", config: genericConfig() }, (m) => progress.push(m));
    expect(done.type).toBe("done");
    expect(done.kind).toBe("generic");
    expect(done.requestId).toBe(42);
    if (done.kind === "generic") {
      expect(done.result.numSimulations).toBe(20);
      expect(done.result.finalR.length).toBe(20);
    }
  });

  it("reports progress with the same requestId as the request", () => {
    const progress: MonteCarloWorkerProgressMessage[] = [];
    handleMonteCarloRequest({ requestId: 7, kind: "generic", config: genericConfig({ numSimulations: 2000 }) }, (m) => progress.push(m));
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(p.requestId).toBe(7);
    expect(progress[progress.length - 1].completed).toBe(2000);
  });
});

function sensitivityConfig(overrides: Partial<SensitivityRunConfig> = {}): SensitivityRunConfig {
  return {
    winRatePct: 40,
    tradesPerSimulation: 10,
    numSimulations: 20,
    seed: 1,
    startingBalance: 1000,
    axes: { riskLevelsPct: [1, 2], rewardRiskRatios: [1, 2] },
    ...overrides,
  };
}

describe("handleMonteCarloRequest - sensitivity (extended protocol)", () => {
  it("dispatches to the sensitivity engine and returns kind: 'sensitivity'", () => {
    const done = handleMonteCarloRequest({ requestId: 55, kind: "sensitivity", config: sensitivityConfig() }, () => {});
    expect(done.type).toBe("done");
    expect(done.kind).toBe("sensitivity");
    expect(done.requestId).toBe(55);
    if (done.kind === "sensitivity") {
      expect(done.result.cells.length).toBe(2);
      expect(done.result.cells[0].length).toBe(2);
    }
  });

  it("reports progress for a sensitivity request with the same requestId, completing at total cell count", () => {
    const progress: MonteCarloWorkerProgressMessage[] = [];
    handleMonteCarloRequest(
      { requestId: 21, kind: "sensitivity", config: sensitivityConfig({ axes: { riskLevelsPct: [1, 2, 3], rewardRiskRatios: [1, 2] } }) },
      (m) => progress.push(m)
    );
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(p.requestId).toBe(21);
    expect(progress[progress.length - 1].completed).toBe(6); // 3 risk levels x 2 RR ratios
    expect(progress[progress.length - 1].total).toBe(6);
  });
});

describe("handleMonteCarloRequest - challenge (extended protocol)", () => {
  it("dispatches to the challenge engine and returns kind: 'challenge'", () => {
    const done = handleMonteCarloRequest({ requestId: 99, kind: "challenge", config: challengeConfig() }, () => {});
    expect(done.type).toBe("done");
    expect(done.kind).toBe("challenge");
    expect(done.requestId).toBe(99);
    if (done.kind === "challenge") {
      expect(done.result.numSimulations).toBe(20);
      expect(done.result.outcomes.length).toBe(20);
    }
  });

  it("reports progress for a challenge request with the same requestId", () => {
    const progress: MonteCarloWorkerProgressMessage[] = [];
    handleMonteCarloRequest(
      { requestId: 13, kind: "challenge", config: challengeConfig({ numSimulations: 1500 }) },
      (m) => progress.push(m)
    );
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(p.requestId).toBe(13);
    expect(progress[progress.length - 1].completed).toBe(1500);
  });
});
