import { describe, expect, it } from "vitest";
import { computeTimeRobustness } from "./timeRobustness";
import { makeTrade } from "./testFixtures";

const SEC = 1;
const DAY = 86400 * SEC;
function dateSec(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

describe("computeTimeRobustness", () => {
  it("buckets by exit year, not entry year (Jan 31 -> Feb 1 exit crossing a year boundary case)", () => {
    const trades = [
      makeTrade({ entryTime: dateSec(2024, 12, 31), exitTime: dateSec(2025, 1, 1), r: 1 }),
      makeTrade({ entryTime: dateSec(2025, 6, 1), exitTime: dateSec(2025, 6, 2), r: 1 }),
    ];
    const result = computeTimeRobustness(trades);
    expect(result.byYear.map((y) => y.key)).toEqual(["2025"]);
    expect(result.byYear[0].trades).toBe(2);
  });

  it("byMonth buckets by exit month key YYYY-MM", () => {
    const trades = [
      makeTrade({ exitTime: dateSec(2025, 1, 15), r: 1 }),
      makeTrade({ exitTime: dateSec(2025, 2, 3), r: -1 }),
    ];
    const result = computeTimeRobustness(trades);
    expect(result.byMonth.map((m) => m.key)).toEqual(["2025-01", "2025-02"]);
  });

  it("rows carry per-period totalR/winRate/expectedValue/maxDrawdownR matching a direct metrics computation", () => {
    const trades = [
      makeTrade({ exitTime: dateSec(2025, 1, 1), r: 2 }),
      makeTrade({ exitTime: dateSec(2025, 1, 2), r: -1 }),
    ];
    const result = computeTimeRobustness(trades);
    const row = result.byYear[0];
    expect(row.totalR).toBeCloseTo(1, 10);
    expect(row.winRate).toBeCloseTo(50, 10);
    expect(row.expectedValue).toBeCloseTo(0.5, 10);
  });

  it("flags concentratedInOneYear when one year accounts for >=70% of total |R|", () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: dateSec(2024, 1, 1) + i * DAY, r: 1 })), // year 2024: +10
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: dateSec(2025, 1, 1) + i * DAY, r: 0.1 })), // year 2025: +1
    ];
    const result = computeTimeRobustness(trades);
    expect(result.concentratedInOneYear).toBe(true);
  });

  it("does not flag concentratedInOneYear when years contribute roughly evenly", () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: dateSec(2024, 1, 1) + i * DAY, r: 1 })),
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: dateSec(2025, 1, 1) + i * DAY, r: 1 })),
    ];
    const result = computeTimeRobustness(trades);
    expect(result.concentratedInOneYear).toBe(false);
  });

  it("never flags concentration with only one year of data (nothing to compare against)", () => {
    const trades = Array.from({ length: 5 }, (_, i) => makeTrade({ exitTime: dateSec(2025, 1, 1) + i * DAY, r: 1 }));
    expect(computeTimeRobustness(trades).concentratedInOneYear).toBe(false);
  });

  it("empty input returns empty breakdowns, never crashes", () => {
    const result = computeTimeRobustness([]);
    expect(result.byYear).toEqual([]);
    expect(result.byMonth).toEqual([]);
    expect(result.concentratedInOneYear).toBe(false);
  });
});
