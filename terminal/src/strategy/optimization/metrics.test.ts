import { describe, expect, it } from "vitest";
import { computeCandidateMetrics, DEFAULT_MIN_SAMPLE_SIZE } from "./metrics";
import { makeTrade, makeTradeSeries } from "./testFixtures";

describe("computeCandidateMetrics", () => {
  it("computes trades/wins/losses/winRate/totalR/avgTradeR/expectedValue", () => {
    const trades = [makeTrade({ r: 2 }), makeTrade({ r: 1 }), makeTrade({ r: -1 })];
    const m = computeCandidateMetrics(trades, 1);
    expect(m.trades).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo((2 / 3) * 100, 6);
    expect(m.totalR).toBeCloseTo(2, 6);
    expect(m.avgTradeR).toBeCloseTo(2 / 3, 6);
    expect(m.expectedValue).toBeCloseTo(m.avgTradeR, 10); // same formula, two labels
  });

  it("profitFactor: sum(winning R) / abs(sum(losing R))", () => {
    const trades = [makeTrade({ r: 3 }), makeTrade({ r: 2 }), makeTrade({ r: -1 }), makeTrade({ r: -1 })];
    const m = computeCandidateMetrics(trades, 1);
    expect(m.profitFactor).toBeCloseTo(5 / 2, 10);
  });

  it("profitFactor is null (not Infinity) when there are no losing trades", () => {
    const trades = [makeTrade({ r: 1 }), makeTrade({ r: 2 })];
    const m = computeCandidateMetrics(trades, 1);
    expect(m.profitFactor).toBeNull();
  });

  it("maxDrawdownR matches the cumulative-R equity curve's worst dip", () => {
    // +1, +1, -3, +1 -> cumulative: 1, 2, -1, 0 -> peak 2, worst dip -3
    const trades = makeTradeSeries(4, 1000, 3600, (i) => [1, 1, -3, 1][i]);
    const m = computeCandidateMetrics(trades, 1);
    expect(m.maxDrawdownR).toBeCloseTo(-3, 10);
  });

  it("maxWinningStreak / maxLosingStreak in exitTime order", () => {
    const trades = makeTradeSeries(5, 1000, 3600, (i) => [1, 1, 1, -1, -1][i]);
    const m = computeCandidateMetrics(trades, 1);
    expect(m.maxWinningStreak).toBe(3);
    expect(m.maxLosingStreak).toBe(2);
  });

  it("marks insufficientSample below the configured minimum, not above", () => {
    const trades = makeTradeSeries(29, 1000, 3600, 1);
    expect(computeCandidateMetrics(trades, 30).insufficientSample).toBe(true);
    expect(computeCandidateMetrics(trades, 29).insufficientSample).toBe(false);
  });

  it("defaults the minimum sample size to 30", () => {
    const trades29 = makeTradeSeries(29, 1000, 3600, 1);
    const trades30 = makeTradeSeries(30, 2_000_000, 3600, 1);
    expect(computeCandidateMetrics(trades29).insufficientSample).toBe(true);
    expect(computeCandidateMetrics(trades30).insufficientSample).toBe(false);
    expect(DEFAULT_MIN_SAMPLE_SIZE).toBe(30);
  });

  it("an insufficient sample is marked, but its raw stats are still computed (never inflated or hidden)", () => {
    const trades = [makeTrade({ r: 5 })];
    const m = computeCandidateMetrics(trades, 30);
    expect(m.insufficientSample).toBe(true);
    expect(m.totalR).toBeCloseTo(5, 10);
    expect(m.trades).toBe(1);
  });

  it("empty trade list produces all-zero metrics, never NaN/Infinity", () => {
    const m = computeCandidateMetrics([], 30);
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.totalR).toBe(0);
    expect(Number.isFinite(m.avgTradeR)).toBe(true);
    expect(m.profitFactor).toBeNull();
    expect(m.bestDay).toBeNull();
    expect(m.worstDay).toBeNull();
    expect(m.insufficientSample).toBe(true);
  });

  it("bestDay/worstDay come from exitTime-bucketed days (dateAnalytics), not entryTime", () => {
    // Two trades on the same exit day should combine into one bestDay entry.
    const dayA = makeTrade({ entryTime: 1_000, exitTime: 5_000, r: 2 });
    const dayA2 = makeTrade({ entryTime: 6_000, exitTime: 8_000, r: 1 });
    const dayB = makeTrade({ entryTime: 90_000, exitTime: 95_000, r: -1 });
    const m = computeCandidateMetrics([dayA, dayA2, dayB], 1);
    expect(m.bestDay?.totalRR).toBeCloseTo(3, 10);
    expect(m.worstDay?.totalRR).toBeCloseTo(-1, 10);
  });
});
