import { describe, expect, it } from "vitest";
import { computeRobustnessScore } from "./robustness";
import type { CandidateMetrics, StabilityResult, SymbolRobustnessResult, TimeRobustnessResult } from "./types";

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalR: 0,
    avgTradeR: 0,
    expectedValue: 0,
    profitFactor: null,
    maxDrawdownR: 0,
    maxWinningStreak: 0,
    maxLosingStreak: 0,
    avgTradesPerDay: 0,
    avgTradesPerWeek: 0,
    avgTradesPerMonth: 0,
    avgTradesPerYear: 0,
    bestDay: null,
    worstDay: null,
    insufficientSample: true,
    ...overrides,
  };
}

const emptySymbols: SymbolRobustnessResult = { bySymbol: [], profitableSymbolsPct: 0, medianSymbolR: 0, worstSymbolR: 0, bestSymbolR: 0, dispersion: null };
const emptyTime: TimeRobustnessResult = { byYear: [], byMonth: [], concentratedInOneYear: false };
const unmeasurableStability: StabilityResult = { comboKey: "x", neighborAvgScore: null, isolationRatio: null, isIsolatedPeak: false };

describe("computeRobustnessScore", () => {
  it("every sub-score and the total are clamped within their documented ranges", () => {
    const m = metrics({ expectedValue: 999, totalR: 999999, maxDrawdownR: -999999, trades: 999999 });
    const result = computeRobustnessScore(m, emptySymbols, emptyTime, unmeasurableStability);
    for (const key of ["evScore", "totalRScore", "drawdownScore", "sampleSizeScore", "symbolConsistencyScore", "timeConsistencyScore", "parameterStabilityScore"] as const) {
      expect(result[key]).toBeGreaterThanOrEqual(0);
      expect(result[key]).toBeLessThanOrEqual(1);
    }
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("a strategy with negative EV, deep drawdown, and no trades scores near the bottom", () => {
    const m = metrics({ expectedValue: -1, totalR: -50, maxDrawdownR: -100, trades: 0 });
    const result = computeRobustnessScore(m, emptySymbols, emptyTime, unmeasurableStability);
    expect(result.evScore).toBe(0);
    expect(result.totalRScore).toBe(0);
    expect(result.drawdownScore).toBe(0);
    expect(result.sampleSizeScore).toBe(0);
    expect(result.total).toBeLessThan(30); // only the two neutral (0.5) consistency scores keep it above 0
  });

  it("a genuinely strong, well-sampled, consistent strategy scores near the top", () => {
    const m = metrics({ expectedValue: 0.5, totalR: 100, maxDrawdownR: -2, trades: 500 });
    const symbols: SymbolRobustnessResult = {
      bySymbol: [
        { symbol: "A", trades: 100, totalR: 10, winRate: 55 },
        { symbol: "B", trades: 100, totalR: 8, winRate: 55 },
      ],
      profitableSymbolsPct: 100,
      medianSymbolR: 9,
      worstSymbolR: 8,
      bestSymbolR: 10,
      dispersion: 0.1,
    };
    const time: TimeRobustnessResult = {
      byYear: [
        { key: "2023", trades: 250, winRate: 55, expectedValue: 0.5, totalR: 50, maxDrawdownR: -1 },
        { key: "2024", trades: 250, winRate: 55, expectedValue: 0.5, totalR: 50, maxDrawdownR: -1 },
      ],
      byMonth: [],
      concentratedInOneYear: false,
    };
    const stability: StabilityResult = { comboKey: "x", neighborAvgScore: 95, isolationRatio: 0.05, isIsolatedPeak: false };
    const result = computeRobustnessScore(m, symbols, time, stability);
    expect(result.total).toBeGreaterThan(90);
  });

  it("an isolated-peak parameter combination scores strictly lower than an otherwise-identical stable one", () => {
    const m = metrics({ expectedValue: 0.4, totalR: 40, maxDrawdownR: -3, trades: 200 });
    const stable: StabilityResult = { comboKey: "a", neighborAvgScore: 38, isolationRatio: 0.05, isIsolatedPeak: false };
    const spike: StabilityResult = { comboKey: "b", neighborAvgScore: 10, isolationRatio: 3, isIsolatedPeak: true };
    const stableScore = computeRobustnessScore(m, emptySymbols, emptyTime, stable).total;
    const spikeScore = computeRobustnessScore(m, emptySymbols, emptyTime, spike).total;
    expect(spikeScore).toBeLessThan(stableScore);
  });

  it("totalRScore is weighted less than the combined consistency scores (robustness > peak performance)", () => {
    // Two candidates with identical, maxed-out totalR/EV but opposite consistency.
    const m = metrics({ expectedValue: 0.3, totalR: 50, maxDrawdownR: 0, trades: 200 });
    const consistentSymbols: SymbolRobustnessResult = {
      bySymbol: [
        { symbol: "A", trades: 1, totalR: 1, winRate: 100 },
        { symbol: "B", trades: 1, totalR: 1, winRate: 100 },
      ],
      profitableSymbolsPct: 100,
      medianSymbolR: 1,
      worstSymbolR: 1,
      bestSymbolR: 1,
      dispersion: 0,
    };
    const inconsistentSymbols: SymbolRobustnessResult = { ...consistentSymbols, profitableSymbolsPct: 0, bySymbol: [
      { symbol: "A", trades: 1, totalR: -1, winRate: 0 },
      { symbol: "B", trades: 1, totalR: -1, winRate: 0 },
    ] };
    const consistentScore = computeRobustnessScore(m, consistentSymbols, emptyTime, unmeasurableStability).total;
    const inconsistentScore = computeRobustnessScore(m, inconsistentSymbols, emptyTime, unmeasurableStability).total;
    expect(consistentScore).toBeGreaterThan(inconsistentScore);
  });
});
