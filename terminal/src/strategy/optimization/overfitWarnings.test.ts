import { describe, expect, it } from "vitest";
import { generateOverfitWarnings, type OverfitWarningInput } from "./overfitWarnings";
import type { CandidateMetrics, StabilityResult, SymbolRobustnessResult, TimeRobustnessResult } from "./types";

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    trades: 100,
    wins: 50,
    losses: 50,
    winRate: 50,
    totalR: 10,
    avgTradeR: 0.1,
    expectedValue: 0.1,
    profitFactor: 1.5,
    maxDrawdownR: -5,
    maxWinningStreak: 4,
    maxLosingStreak: 4,
    avgTradesPerDay: 1,
    avgTradesPerWeek: 5,
    avgTradesPerMonth: 20,
    avgTradesPerYear: 240,
    bestDay: null,
    worstDay: null,
    insufficientSample: false,
    ...overrides,
  };
}

const stableStability: StabilityResult = { comboKey: "x", neighborAvgScore: 10, isolationRatio: 0.1, isIsolatedPeak: false };
const isolatedStability: StabilityResult = { comboKey: "x", neighborAvgScore: 10, isolationRatio: 2, isIsolatedPeak: true };
const consistentSymbols: SymbolRobustnessResult = {
  bySymbol: [
    { symbol: "A", trades: 10, totalR: 5, winRate: 60 },
    { symbol: "B", trades: 10, totalR: 5, winRate: 60 },
  ],
  profitableSymbolsPct: 100,
  medianSymbolR: 5,
  worstSymbolR: 5,
  bestSymbolR: 5,
  dispersion: 0,
};
const flatTime: TimeRobustnessResult = { byYear: [], byMonth: [], concentratedInOneYear: false };

function baseInput(overrides: Partial<OverfitWarningInput> = {}): OverfitWarningInput {
  return {
    evDegradationPct: 0,
    totalRDegradationPct: 0,
    stability: stableStability,
    symbolRobustness: consistentSymbols,
    timeRobustness: flatTime,
    testMetrics: metrics(),
    ...overrides,
  };
}

describe("generateOverfitWarnings", () => {
  it("a clean candidate (no degradation, stable, consistent) produces no warnings", () => {
    expect(generateOverfitWarnings(baseInput())).toEqual([]);
  });

  it("HIGH severity when Train->Test degradation is severe (>=80%)", () => {
    const warnings = generateOverfitWarnings(baseInput({ evDegradationPct: -90 }));
    expect(warnings.some((w) => w.severity === "high")).toBe(true);
  });

  it("a Train->Test sign flip (positive train EV, negative test EV) is captured as HIGH via the degradation %", () => {
    // train=+2R, test=-1R -> -150% degradation, computed by the caller via computeDegradationPct
    const warnings = generateOverfitWarnings(baseInput({ evDegradationPct: -150 }));
    expect(warnings.some((w) => w.severity === "high")).toBe(true);
  });

  it("MEDIUM severity for moderate degradation (40-80%)", () => {
    const warnings = generateOverfitWarnings(baseInput({ evDegradationPct: -50 }));
    expect(warnings.some((w) => w.severity === "medium")).toBe(true);
    expect(warnings.some((w) => w.severity === "high")).toBe(false);
  });

  it("LOW severity for mild degradation (<40%)", () => {
    const warnings = generateOverfitWarnings(baseInput({ evDegradationPct: -10 }));
    expect(warnings.some((w) => w.severity === "low")).toBe(true);
    expect(warnings.some((w) => w.severity !== "low")).toBe(false);
  });

  it("improvement (positive degradation) never produces a warning", () => {
    expect(generateOverfitWarnings(baseInput({ evDegradationPct: 50, totalRDegradationPct: 50 }))).toEqual([]);
  });

  it("flags an isolated-peak parameter combination as MEDIUM", () => {
    const warnings = generateOverfitWarnings(baseInput({ stability: isolatedStability }));
    expect(warnings.some((w) => w.severity === "medium" && w.message.toLowerCase().includes("isolated"))).toBe(true);
  });

  it("flags poor cross-symbol consistency", () => {
    const badSymbols: SymbolRobustnessResult = { ...consistentSymbols, profitableSymbolsPct: 25 };
    const warnings = generateOverfitWarnings(baseInput({ symbolRobustness: badSymbols }));
    expect(warnings.some((w) => w.severity === "high" && w.message.includes("symbols"))).toBe(true);
  });

  it("does not flag cross-symbol consistency with only one symbol tested (nothing to compare)", () => {
    const oneSymbol: SymbolRobustnessResult = {
      bySymbol: [{ symbol: "A", trades: 10, totalR: -5, winRate: 30 }],
      profitableSymbolsPct: 0,
      medianSymbolR: -5,
      worstSymbolR: -5,
      bestSymbolR: -5,
      dispersion: null,
    };
    const warnings = generateOverfitWarnings(baseInput({ symbolRobustness: oneSymbol }));
    expect(warnings.some((w) => w.message.includes("symbols"))).toBe(false);
  });

  it("flags year concentration", () => {
    const concentrated: TimeRobustnessResult = { byYear: [], byMonth: [], concentratedInOneYear: true };
    const warnings = generateOverfitWarnings(baseInput({ timeRobustness: concentrated }));
    expect(warnings.some((w) => w.message.toLowerCase().includes("single year"))).toBe(true);
  });

  it("flags an insufficient test-period sample", () => {
    const warnings = generateOverfitWarnings(baseInput({ testMetrics: metrics({ insufficientSample: true, trades: 5 }) }));
    expect(warnings.some((w) => w.severity === "low" && w.message.includes("5 trade"))).toBe(true);
  });

  it("multiple independent problems produce multiple independent warnings", () => {
    const warnings = generateOverfitWarnings(
      baseInput({
        evDegradationPct: -90,
        stability: isolatedStability,
        timeRobustness: { byYear: [], byMonth: [], concentratedInOneYear: true },
      })
    );
    expect(warnings.length).toBe(3);
  });
});
