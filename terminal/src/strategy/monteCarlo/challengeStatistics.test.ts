import { describe, expect, it } from "vitest";
import {
  aggregateChallengeStats,
  breakEvenAnalysis,
  confidenceCost90,
  consecutiveFailureRisk,
  expectedAttempts,
  expectedCost,
  expectedTradesToFund,
  passRateOf,
  tradesToSuccessStats,
} from "./challengeStatistics";
import { createRng } from "./rng";

describe("passRateOf / tradesToSuccessStats (spec items 10-14)", () => {
  it("computes pass rate as successes / total", () => {
    const outcomes = Uint8Array.from([1, 1, 0, 1, 0]); // 3/5 = 60%
    expect(passRateOf(outcomes)).toBeCloseTo(0.6);
  });

  it("fail rate = 1 - pass rate (verified via aggregateChallengeStats)", () => {
    const outcomes = Uint8Array.from([1, 1, 0, 1, 0]);
    const tradesUsed = Int32Array.from([10, 12, 20, 8, 20]);
    const stats = aggregateChallengeStats(outcomes, tradesUsed, 500, createRng(1));
    expect(stats.passRate + stats.failRate).toBeCloseTo(100);
  });

  it("trades-to-success mean/median only counts PASS attempts", () => {
    const outcomes = Uint8Array.from([1, 0, 1, 0]);
    const tradesUsed = Int32Array.from([10, 99, 30, 99]); // failed attempts' counts must be excluded
    const tts = tradesToSuccessStats(outcomes, tradesUsed)!;
    expect(tts.mean).toBe(20); // (10+30)/2
    expect(tts.median).toBe(20);
  });

  it("returns null when there are no successful attempts", () => {
    const outcomes = Uint8Array.from([0, 0, 0]);
    const tradesUsed = Int32Array.from([5, 5, 5]);
    expect(tradesToSuccessStats(outcomes, tradesUsed)).toBeNull();
  });
});

describe("expectedAttempts / expectedCost (spec items 15-18)", () => {
  it("expected attempts = 1 / pass rate", () => {
    expect(expectedAttempts(0.5)).toBeCloseTo(2);
    expect(expectedAttempts(0.74)).toBeCloseTo(1 / 0.74);
  });

  it("pass rate of 0 is handled safely (null, never Infinity)", () => {
    expect(expectedAttempts(0)).toBeNull();
    expect(expectedCost(expectedAttempts(0), 500)).toBeNull();
  });

  it("expected cost = fee x expected attempts", () => {
    const attempts = expectedAttempts(0.5)!;
    expect(expectedCost(attempts, 500)).toBeCloseTo(1000);
  });

  it("zero fee handled correctly", () => {
    expect(expectedCost(expectedAttempts(0.5), 0)).toBe(0);
  });

  it("expected trades to fund uses the spec's own formula (attempts x avg trades per success)", () => {
    const attempts = expectedAttempts(0.5)!; // 2
    expect(expectedTradesToFund(attempts, 21)).toBeCloseTo(42);
  });
});

describe("confidenceCost90 (spec item 19)", () => {
  it("computes a 90th percentile cost from simulated funding journeys", () => {
    const outcomes = new Uint8Array(2000);
    for (let i = 0; i < outcomes.length; i++) outcomes[i] = i % 2; // alternating - 50% pass rate
    const cost = confidenceCost90(outcomes, 500, createRng(7))!;
    expect(cost).toBeGreaterThan(500); // more than a single attempt's fee
    expect(Number.isFinite(cost)).toBe(true);
  });

  it("returns null when no simulated attempt ever passed", () => {
    const outcomes = new Uint8Array(500); // all zeros
    expect(confidenceCost90(outcomes, 500, createRng(1))).toBeNull();
  });

  it("is deterministic for the same rng seed", () => {
    const outcomes = Uint8Array.from({ length: 1000 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const a = confidenceCost90(outcomes, 500, createRng(99));
    const b = confidenceCost90(outcomes, 500, createRng(99));
    expect(a).toBe(b);
  });
});

describe("consecutiveFailureRisk (spec items 20-21)", () => {
  it("computes (1-passRate)^threshold - a property of CHALLENGE ATTEMPTS, not trades", () => {
    expect(consecutiveFailureRisk(0.6, 5)).toBeCloseTo(Math.pow(0.4, 5));
  });
  it("supports 3+, 5+, 10+ thresholds", () => {
    const p = 0.5;
    expect(consecutiveFailureRisk(p, 3)).toBeCloseTo(0.125);
    expect(consecutiveFailureRisk(p, 5)).toBeCloseTo(0.03125);
    expect(consecutiveFailureRisk(p, 10)).toBeCloseTo(Math.pow(0.5, 10));
  });
});

describe("breakEvenAnalysis", () => {
  it("computes the funded-profit break-even % from expectedCost/accountSize/profitSplit only - no invented payout assumption", () => {
    const result = breakEvenAnalysis(1000, 100000, 80);
    // 1000 / (100000 * 0.8) * 100 = 1.25%
    expect(result.breakEvenFundedProfitPct).toBeCloseTo(1.25);
  });

  it("returns null when expectedCost is null (effectively impossible configuration)", () => {
    const result = breakEvenAnalysis(null, 100000, 80);
    expect(result.breakEvenFundedProfitPct).toBeNull();
  });
});

describe("aggregateChallengeStats - edge cases", () => {
  it("pass rate = 1 (all pass)", () => {
    const outcomes = new Uint8Array(10).fill(1);
    const tradesUsed = new Int32Array(10).fill(15);
    const stats = aggregateChallengeStats(outcomes, tradesUsed, 500, createRng(1));
    expect(stats.passRate).toBe(100);
    expect(stats.expectedAttempts).toBeCloseTo(1);
    expect(stats.expectedCost).toBeCloseTo(500);
  });

  it("pass rate = 0 (all fail) - never NaN/Infinity/undefined", () => {
    const outcomes = new Uint8Array(10);
    const tradesUsed = new Int32Array(10).fill(15);
    const stats = aggregateChallengeStats(outcomes, tradesUsed, 500, createRng(1));
    expect(stats.passRate).toBe(0);
    expect(stats.expectedAttempts).toBeNull();
    expect(stats.expectedCost).toBeNull();
    expect(stats.confidenceCost90).toBeNull();
    expect(stats.tradesToSuccess).toBeNull();
  });
});
