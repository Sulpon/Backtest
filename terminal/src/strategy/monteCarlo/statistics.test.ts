import { describe, expect, it } from "vitest";
import {
  aggregateResults,
  drawdownStats,
  equityEnvelope,
  histogramBins,
  median,
  percentile,
  probabilityPositive,
  streakStats,
} from "./statistics";
import { runMonteCarlo } from "./engine";
import type { MonteCarloRawResult } from "./types";

describe("percentile / median (spec item 23-24)", () => {
  it("computes the correct median for odd and even length arrays", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes standard percentiles with linear interpolation", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 50)).toBe(30);
  });

  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
    expect(median([])).toBe(0);
  });
});

describe("probabilityPositive (spec item 25)", () => {
  it("computes the % of strictly-positive values", () => {
    expect(probabilityPositive([1, -1, 2, -2, 3])).toBe(60);
  });
  it("returns 0 for an empty array", () => {
    expect(probabilityPositive([])).toBe(0);
  });
});

describe("drawdownStats percentile convention (spec item 26)", () => {
  it("orders severity so p95 is worse (more negative) than median, and worst is the minimum", () => {
    // 100 evenly spaced drawdown values from -1 (least severe) to -100 (worst).
    const values = Array.from({ length: 100 }, (_, i) => -(i + 1));
    const stats = drawdownStats(values);
    expect(stats.worst).toBe(-100);
    expect(stats.p95).toBeLessThan(stats.p90);
    expect(stats.p90).toBeLessThan(stats.p75);
    expect(stats.p75).toBeLessThan(stats.median);
  });
});

describe("streakStats percentile convention (spec item 27)", () => {
  it("orders severity so p95 is larger than median, and max is the maximum", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = streakStats(values);
    expect(stats.max).toBe(100);
    expect(stats.p95).toBeGreaterThan(stats.p90);
    expect(stats.p90).toBeGreaterThan(stats.p75);
    expect(stats.p75).toBeGreaterThan(stats.median);
  });
});

describe("aggregateResults / equityEnvelope / histogramBins - structural", () => {
  const raw: MonteCarloRawResult = runMonteCarlo({
    numSimulations: 200,
    tradesPerSimulation: 40,
    seed: 7,
    source: { kind: "simple", params: { winRatePct: 45, avgWinR: 2, avgLossR: 1 } },
  });

  it("aggregateResults produces every documented field, finite", () => {
    const agg = aggregateResults(raw);
    for (const group of [agg.finalR, agg.maxDrawdown, agg.winningStreak, agg.losingStreak]) {
      for (const v of Object.values(group)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("equityEnvelope's median point never exceeds its own p95 point", () => {
    for (const point of equityEnvelope(raw)) {
      expect(point.median).toBeLessThanOrEqual(point.p95);
      expect(point.p5).toBeLessThanOrEqual(point.median);
    }
  });

  it("histogramBins covers every value with no bin undercounting the total", () => {
    const bins = histogramBins(raw.finalR, 10);
    const total = bins.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(raw.finalR.length);
  });

  it("histogramBins handles an empty input", () => {
    expect(histogramBins([])).toEqual([]);
  });
});
