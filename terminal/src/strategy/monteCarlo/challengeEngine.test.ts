import { describe, expect, it } from "vitest";
import { generateChallengeRSequence, runChallengeMonteCarlo, simulateChallengeFromSequence } from "./challengeEngine";
import type { ChallengeConfig } from "./challengeTypes";
import type { OutcomeSource } from "./types";

function singlePhaseConfig(overrides: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return {
    challengeType: "single",
    phase1: { profitTargetPct: 8, maxDrawdownPct: 10 },
    phase2: null,
    drawdownType: "initial",
    dailyDrawdownPct: null,
    profitSplitPct: 80,
    challengeFee: 500,
    ...overrides,
  };
}

describe("simulateChallengeFromSequence - pass/fail (spec items 1-6)", () => {
  it("PASS when equity reaches the profit target", () => {
    const rSeq = Array(20).fill(1); // all +1R wins
    const result = simulateChallengeFromSequence(rSeq, singlePhaseConfig(), 1, 100000, 20, null);
    expect(result.outcome).toBe("PASS");
    expect(result.stopReason).toBe("target");
  });

  it("FAIL when equity reaches max drawdown", () => {
    const rSeq = Array(20).fill(-1); // all -1R losses
    const result = simulateChallengeFromSequence(rSeq, singlePhaseConfig(), 1, 100000, 20, null);
    expect(result.outcome).toBe("FAIL");
    expect(result.stopReason).toBe("maxDrawdown");
  });

  it("FAIL (exhausted) when the trade budget runs out before target or drawdown", () => {
    const rSeq = Array(5).fill(0.01); // tiny wins, never reach 8%, never breach DD
    const result = simulateChallengeFromSequence(rSeq, singlePhaseConfig(), 1, 100000, 5, null);
    expect(result.outcome).toBe("FAIL");
    expect(result.stopReason).toBe("exhausted");
    expect(result.tradesUsed).toBe(5);
  });

  it("daily drawdown breach -> FAIL", () => {
    const config = singlePhaseConfig({ dailyDrawdownPct: 5 });
    const rSeq = [-6]; // -6% in a single trade at 1% risk: > 5% daily DD but < 10% max DD
    const result = simulateChallengeFromSequence(rSeq, config, 1, 100000, 10, 1);
    expect(result.outcome).toBe("FAIL");
    expect(result.stopReason).toBe("dailyDrawdown");
  });

  it("trailing drawdown breach after a new equity high raises the floor", () => {
    const config = singlePhaseConfig({ drawdownType: "trailing", phase1: { profitTargetPct: 50, maxDrawdownPct: 10 } });
    const rSeq = [10, 10, -3, -3, -3, -3, -3, -3];
    const result = simulateChallengeFromSequence(rSeq, config, 1, 100000, 20, null);
    expect(result.outcome).toBe("FAIL");
    expect(result.stopReason).toBe("maxDrawdown");
    const initialFloor = 100000 * 0.9;
    expect(Math.max(...result.thresholdPath)).toBeGreaterThan(initialFloor);
  });

  it("initial drawdown floor never moves regardless of new equity highs", () => {
    const config = singlePhaseConfig({ drawdownType: "initial", phase1: { profitTargetPct: 50, maxDrawdownPct: 10 } });
    const rSeq = [10, 10, -3, -3, -3, -3];
    const result = simulateChallengeFromSequence(rSeq, config, 1, 100000, 20, null);
    const floors = new Set(result.thresholdPath);
    expect(floors.size).toBe(1);
    expect([...floors][0]).toBeCloseTo(90000);
  });
});

describe("Two Phase (spec items 7-9)", () => {
  function twoPhaseConfig(): ChallengeConfig {
    return {
      challengeType: "two-phase",
      phase1: { profitTargetPct: 8, maxDrawdownPct: 10 },
      phase2: { profitTargetPct: 5, maxDrawdownPct: 10 },
      drawdownType: "initial",
      dailyDrawdownPct: null,
      profitSplitPct: 80,
      challengeFee: 500,
    };
  }

  it("Phase 1 failure -> overall FAIL, Phase 2 never attempted", () => {
    const rSeq = [...Array(10).fill(-1), ...Array(10).fill(1)];
    const result = simulateChallengeFromSequence(rSeq, twoPhaseConfig(), 1, 100000, 10, null);
    expect(result.outcome).toBe("FAIL");
    expect(result.phaseOutcomes).toEqual(["PHASE_1_FAIL"]);
    expect(result.phaseBoundaryTradeIndex).toBeNull();
  });

  it("Phase 1 pass + Phase 2 fail -> overall FAIL", () => {
    const rSeq = [...Array(10).fill(1), ...Array(10).fill(-1)];
    const result = simulateChallengeFromSequence(rSeq, twoPhaseConfig(), 1, 100000, 10, null);
    expect(result.outcome).toBe("FAIL");
    expect(result.phaseOutcomes).toEqual(["PHASE_1_PASS", "PHASE_2_FAIL"]);
    expect(result.phaseBoundaryTradeIndex).not.toBeNull();
  });

  it("Phase 1 pass + Phase 2 pass -> overall PASS", () => {
    const rSeq = Array(20).fill(1);
    const result = simulateChallengeFromSequence(rSeq, twoPhaseConfig(), 1, 100000, 10, null);
    expect(result.outcome).toBe("PASS");
    expect(result.phaseOutcomes).toEqual(["PHASE_1_PASS", "PHASE_2_PASS"]);
  });
});

describe("compounding / risk-to-equity (spec items 22-23)", () => {
  it("applies compounding, not naive additive R x risk%", () => {
    const rSeq = [1, 1, 1];
    const result = simulateChallengeFromSequence(rSeq, singlePhaseConfig({ phase1: { profitTargetPct: 100, maxDrawdownPct: 100 } }), 1, 100000, 3, null);
    // Compounded: 100000 * 1.01^3 = 103030.1; naive additive would be 103000.
    expect(result.equityPath[2]).toBeCloseTo(103030.1, 1);
    expect(result.equityPath[2]).not.toBeCloseTo(103000, 1);
  });
});

describe("determinism (spec items 25-26)", () => {
  const source: OutcomeSource = { kind: "simple", params: { winRatePct: 50, avgWinR: 1, avgLossR: 1 } };
  function config(seed: number) {
    return {
      numSimulations: 100,
      tradesPerPhaseCap: 20,
      seed,
      source,
      riskPct: 1,
      accountSize: 100000,
      challenge: singlePhaseConfig(),
      tradesPerDay: null,
    };
  }

  it("same seed -> identical challenge simulation", () => {
    const a = runChallengeMonteCarlo(config(42));
    const b = runChallengeMonteCarlo(config(42));
    expect(Array.from(a.outcomes)).toEqual(Array.from(b.outcomes));
    expect(Array.from(a.tradesUsed)).toEqual(Array.from(b.tradesUsed));
  });

  it("different seed -> different challenge simulation", () => {
    const a = runChallengeMonteCarlo(config(1));
    const b = runChallengeMonteCarlo(config(2));
    expect(Array.from(a.outcomes)).not.toEqual(Array.from(b.outcomes));
  });
});

describe("generateChallengeRSequence", () => {
  it("draws exactly totalLength outcomes", () => {
    const source: OutcomeSource = { kind: "simple", params: { winRatePct: 50, avgWinR: 1, avgLossR: 1 } };
    const seq = generateChallengeRSequence(source, () => 0.4, 25);
    expect(seq.length).toBe(25);
  });
});
