import { describe, expect, it } from "vitest";
import { compoundEquityFromR, equityMultiplierForR, riskComparison, simpleRiskPercent } from "./riskEquity";

describe("simpleRiskPercent (spec items 28-30)", () => {
  it("1R at 1% risk = +1%", () => {
    expect(simpleRiskPercent(1, 1)).toBe(1);
  });
  it("-1R at 1% risk = -1%", () => {
    expect(simpleRiskPercent(-1, 1)).toBe(-1);
  });
  it("2R at 1% risk = +2%", () => {
    expect(simpleRiskPercent(2, 1)).toBe(2);
  });
});

describe("equityMultiplierForR", () => {
  it("matches the spec's per-trade multiplier examples", () => {
    expect(equityMultiplierForR(1, 1)).toBeCloseTo(1.01);
    expect(equityMultiplierForR(-1, 1)).toBeCloseTo(0.99);
    expect(equityMultiplierForR(2, 1)).toBeCloseTo(1.02);
  });

  it("clamps at 0 rather than going negative for an extreme loss", () => {
    expect(equityMultiplierForR(-100, 3)).toBe(0);
  });
});

describe("compoundEquityFromR (spec item 31)", () => {
  it("compounds trade by trade, never total-R * risk% (a $100,000 example)", () => {
    const path = compoundEquityFromR([1, -1, 2], 1, 100000);
    // 100000 * 1.01 = 101000; * 0.99 = 99990; * 1.02 = 101989.8
    expect(path[0]).toBeCloseTo(101000);
    expect(path[1]).toBeCloseTo(99990);
    expect(path[2]).toBeCloseTo(101989.8, 1);
    // The naive (wrong) non-compounded shortcut would give
    // 100000 * (1 + (1-1+2)*0.01) = 102000 - a materially different number.
    expect(path[2]).not.toBeCloseTo(102000, 0);
  });

  it("returns an empty path for an empty sequence", () => {
    expect(compoundEquityFromR([], 1, 100000)).toEqual([]);
  });
});

describe("riskComparison", () => {
  it("produces one row per risk level, all using the same input R sequences", () => {
    const sequences = [
      [1, -1, 2, -1, 1],
      [-1, -1, 1, 1, 1],
      [2, 1, -1, -1, -1],
    ];
    const rows = riskComparison(sequences);
    expect(rows.map((r) => r.riskPct)).toEqual([0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]);
    for (const row of rows) {
      expect(Number.isFinite(row.medianReturnPct)).toBe(true);
      expect(row.p95MaxDrawdownPct).toBeLessThanOrEqual(0);
      expect(row.probabilityPositive).toBeGreaterThanOrEqual(0);
      expect(row.probabilityPositive).toBeLessThanOrEqual(100);
    }
  });

  it("higher risk levels widen the return distribution (larger |median return|) for a net-positive sample", () => {
    const sequences = [[1, 1, 1, -1]];
    const rows = riskComparison(sequences);
    const low = rows.find((r) => r.riskPct === 0.25)!;
    const high = rows.find((r) => r.riskPct === 3.0)!;
    expect(Math.abs(high.medianReturnPct)).toBeGreaterThan(Math.abs(low.medianReturnPct));
  });
});
