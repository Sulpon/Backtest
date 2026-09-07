import { describe, expect, it } from "vitest";
import { challengeRiskComparison } from "./challengeRiskComparison";
import { simulateChallengeFromSequence } from "./challengeEngine";
import type { ChallengeConfig } from "./challengeTypes";

const config: ChallengeConfig = {
  challengeType: "single",
  phase1: { profitTargetPct: 8, maxDrawdownPct: 10 },
  phase2: null,
  drawdownType: "initial",
  dailyDrawdownPct: null,
  profitSplitPct: 80,
  challengeFee: 500,
};

describe("challengeRiskComparison (spec item 24)", () => {
  it("produces one row per canonical risk level", () => {
    const sequences = [Array(20).fill(1), Array(20).fill(-1), Array(20).fill(0.5)];
    const rows = challengeRiskComparison(sequences, config, 100000, 20, null, 500, 42);
    expect(rows.map((r) => r.riskPct)).toEqual([0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]);
  });

  it("replays the SAME retained sequences at each risk level (consistent underlying outcomes)", () => {
    const sequences = [Array(20).fill(1), Array(20).fill(-1)];
    const rows = challengeRiskComparison(sequences, config, 100000, 20, null, 500, 42);
    const row1pct = rows.find((r) => r.riskPct === 1.0)!;
    const manualOutcomes = sequences.map((seq) => simulateChallengeFromSequence(seq, config, 1.0, 100000, 20, null).outcome);
    const manualPassRate = (manualOutcomes.filter((o) => o === "PASS").length / manualOutcomes.length) * 100;
    expect(row1pct.stats.passRate).toBeCloseTo(manualPassRate);
  });

  it("does not assume monotonic pass-rate behavior across risk levels - every row stays within [0,100]", () => {
    const sequences = [[2, 2, 2, -5, -5, -5]];
    const rows = challengeRiskComparison(sequences, config, 100000, 20, null, 500, 1);
    for (const row of rows) {
      expect(row.stats.passRate).toBeGreaterThanOrEqual(0);
      expect(row.stats.passRate).toBeLessThanOrEqual(100);
    }
  });
});
