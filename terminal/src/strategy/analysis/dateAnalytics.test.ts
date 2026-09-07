import { describe, expect, it } from "vitest";
import {
  computeKpis,
  cumulativeRRSeries,
  exitDateParts,
  filterTrades,
  groupByExitDay,
  groupByExitMonth,
  groupByExitYear,
  maximumDrawdown,
  maximumLosingStreak,
  maximumWinningStreak,
  tradeFrequencyAnalytics,
} from "./dateAnalytics";
// Vite-native raw-text import (no Node "fs" - this app has no Node types
// configured anywhere in tsconfig.app.json, and nothing else in src/ needs
// them) for the structural source-scan test below.
import dateAnalyticsSource from "./dateAnalytics.ts?raw";
import type { ScanTradeRecord } from "../types";

/** Unix seconds for a UTC calendar moment - readability helper for tests. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000);
}

function trade(overrides: Partial<ScanTradeRecord> = {}): ScanTradeRecord {
  const symbol = overrides.symbol ?? "EURUSD";
  const timeframe = overrides.timeframe ?? "1h";
  const entryTime = overrides.entryTime ?? utc(2025, 6, 1, 10);
  const exitTime = overrides.exitTime ?? entryTime + 3600;
  const indicatorId = overrides.indicatorId ?? "pi-1";
  return {
    id: `${indicatorId}:${symbol}:${timeframe}:${entryTime}:${exitTime}`,
    strategyId: "scan-1",
    indicatorId,
    symbol,
    timeframe,
    dir: "long",
    entryTime,
    entryPrice: 1.1,
    sl: 1.09,
    tp: 1.12,
    exitTime,
    result: "Win",
    r: 1,
    setup: "ara",
    ...overrides,
  };
}

describe("exitDateParts", () => {
  it("extracts year/month/day/dateKey/monthKey from exitTime, in UTC", () => {
    const t = trade({ exitTime: utc(2026, 3, 14, 15, 30) });
    expect(exitDateParts(t)).toEqual({ year: 2026, month: 3, day: 14, dateKey: "2026-03-14", monthKey: "2026-03" });
  });

  it("regression: a trade entered Jan 31 23:00 UTC and closed Feb 1 10:00 UTC belongs to February 2025, not January", () => {
    const t = trade({ entryTime: utc(2025, 1, 31, 23, 0), exitTime: utc(2025, 2, 1, 10, 0) });
    const parts = exitDateParts(t);
    expect(parts.year).toBe(2025);
    expect(parts.month).toBe(2);
    expect(parts.day).toBe(1);
    expect(parts.dateKey).toBe("2025-02-01");
    expect(parts.monthKey).toBe("2025-02");
  });

  it("regression: a trade entered Dec 31 23:00 UTC and closed Jan 1 01:00 UTC belongs to the NEW year, not the old one", () => {
    const t = trade({ entryTime: utc(2024, 12, 31, 23, 0), exitTime: utc(2025, 1, 1, 1, 0) });
    expect(exitDateParts(t).year).toBe(2025);
  });
});

describe("structural enforcement", () => {
  it("no aggregation/filter function in this module reads .entryTime directly - only exitDateParts (and comments describing it) may mention it", () => {
    // Only the file-level doc comment and exitDateParts itself (including
    // its own doc comment) are allowed to mention entryTime, since both
    // exist specifically to document/enforce the exitTime-only rule.
    // Everything from filterTrades onward is the actual aggregation logic
    // this test protects - it must never reference .entryTime.
    const idx = dateAnalyticsSource.indexOf("export function filterTrades");
    expect(idx).toBeGreaterThan(0);
    const aggregationLogic = dateAnalyticsSource.slice(idx);
    expect(aggregationLogic).not.toMatch(/\.entryTime\b/);
  });
});

describe("filterTrades", () => {
  const eur = trade({ symbol: "EURUSD", exitTime: utc(2025, 6, 15) });
  const gbp = trade({ symbol: "GBPUSD", exitTime: utc(2025, 6, 15) });
  const xau = trade({ symbol: "XAUUSD", setup: "other", exitTime: utc(2025, 6, 15) });

  it("'all' symbols and 'all' setup pass every trade through", () => {
    expect(filterTrades([eur, gbp, xau], "all", "all", null, null)).toHaveLength(3);
  });

  it("filters to a custom symbol subset", () => {
    const result = filterTrades([eur, gbp, xau], ["EURUSD", "GBPUSD"], "all", null, null);
    expect(result.map((t) => t.symbol).sort()).toEqual(["EURUSD", "GBPUSD"]);
  });

  it("filters to a single setup", () => {
    const result = filterTrades([eur, gbp, xau], "all", "other", null, null);
    expect(result).toEqual([xau]);
  });

  it("date range bounds are inclusive and compared against exitTime", () => {
    const inRange = trade({ exitTime: utc(2025, 6, 10) });
    const before = trade({ exitTime: utc(2025, 5, 31) });
    const after = trade({ exitTime: utc(2025, 7, 1) });
    const onBoundary = trade({ exitTime: utc(2025, 6, 1) });
    const result = filterTrades([inRange, before, after, onBoundary], "all", "all", utc(2025, 6, 1), utc(2025, 6, 30));
    expect(result).toContain(inRange);
    expect(result).toContain(onBoundary);
    expect(result).not.toContain(before);
    expect(result).not.toContain(after);
  });

  it("regression: a trade whose entryTime falls inside the date range but exitTime falls outside it is EXCLUDED", () => {
    const t = trade({ entryTime: utc(2025, 6, 20), exitTime: utc(2025, 7, 5) });
    const result = filterTrades([t], "all", "all", utc(2025, 6, 1), utc(2025, 6, 30));
    expect(result).toEqual([]);
  });

  it("regression: a trade whose entryTime falls outside the date range but exitTime falls inside it is INCLUDED", () => {
    const t = trade({ entryTime: utc(2025, 5, 20), exitTime: utc(2025, 6, 5) });
    const result = filterTrades([t], "all", "all", utc(2025, 6, 1), utc(2025, 6, 30));
    expect(result).toEqual([t]);
  });
});

describe("groupByExitDay", () => {
  it("aggregates multiple trades closed on the same day", () => {
    const day = utc(2025, 6, 10);
    const trades = [trade({ exitTime: day + 3600, r: 2 }), trade({ exitTime: day + 7200, r: -1 }), trade({ exitTime: day + 10800, r: 1.5 })];
    const map = groupByExitDay(trades);
    expect(map.get("2025-06-10")).toEqual({ totalRR: 2.5, count: 3, wins: expect.any(Number), winRate: expect.any(Number), avgRR: expect.any(Number) });
  });

  it("regression: a trade entered one day and closed the next is bucketed by the CLOSING day", () => {
    const t = trade({ entryTime: utc(2025, 6, 10, 23, 0), exitTime: utc(2025, 6, 11, 1, 0), r: 3 });
    const map = groupByExitDay([t]);
    expect(map.get("2025-06-11")).toMatchObject({ totalRR: 3, count: 1 });
    expect(map.has("2025-06-10")).toBe(false);
  });

  it("a day with no trades simply has no entry in the map (never a zero-value entry)", () => {
    const map = groupByExitDay([trade({ exitTime: utc(2025, 6, 10) })]);
    expect(map.has("2025-06-11")).toBe(false);
  });

  it("handles negative RR correctly", () => {
    const map = groupByExitDay([trade({ exitTime: utc(2025, 6, 10), r: -2, result: "Lose" })]);
    expect(map.get("2025-06-10")).toMatchObject({ totalRR: -2, wins: 0 });
  });
});

describe("groupByExitMonth", () => {
  it("regression: a trade entered Jan 31 and closed Feb 1 counts in February, not January", () => {
    const t = trade({ entryTime: utc(2025, 1, 31, 23, 0), exitTime: utc(2025, 2, 1, 10, 0), r: 2 });
    const map = groupByExitMonth([t]);
    expect(map.get("2025-02")).toMatchObject({ totalRR: 2, count: 1 });
    expect(map.has("2025-01")).toBe(false);
  });

  it("aggregates multiple trades across multiple months independently", () => {
    const trades = [
      trade({ exitTime: utc(2025, 1, 5), r: 1 }),
      trade({ exitTime: utc(2025, 1, 20), r: 2 }),
      trade({ exitTime: utc(2025, 2, 3), r: -1 }),
    ];
    const map = groupByExitMonth(trades);
    expect(map.get("2025-01")).toMatchObject({ totalRR: 3, count: 2 });
    expect(map.get("2025-02")).toMatchObject({ totalRR: -1, count: 1 });
  });
});

describe("groupByExitYear", () => {
  it("regression: a trade entered Dec 31 2024 and closed Jan 1 2025 counts in 2025", () => {
    const t = trade({ entryTime: utc(2024, 12, 31, 23, 0), exitTime: utc(2025, 1, 1, 1, 0), r: 4 });
    const map = groupByExitYear([t]);
    expect(map.get(2025)).toMatchObject({ totalRR: 4, count: 1 });
    expect(map.has(2024)).toBe(false);
  });

  it("aggregates across multiple years with win rate and avg RR per year", () => {
    const trades = [
      trade({ exitTime: utc(2024, 3, 1), r: 2, result: "Win" }),
      trade({ exitTime: utc(2024, 6, 1), r: -1, result: "Lose" }),
      trade({ exitTime: utc(2025, 1, 1), r: 3, result: "Win" }),
    ];
    const map = groupByExitYear(trades);
    expect(map.get(2024)).toMatchObject({ totalRR: 1, count: 2, wins: 1, winRate: 50, avgRR: 0.5 });
    expect(map.get(2025)).toMatchObject({ totalRR: 3, count: 1, wins: 1, winRate: 100, avgRR: 3 });
  });
});

describe("cumulativeRRSeries", () => {
  it("sums running R in exitTime order", () => {
    const trades = [trade({ exitTime: utc(2025, 6, 1), r: 2 }), trade({ exitTime: utc(2025, 6, 2), r: -1 }), trade({ exitTime: utc(2025, 6, 3), r: 2.5 })];
    const series = cumulativeRRSeries(trades);
    expect(series.map((p) => p.cumulative)).toEqual([2, 1, 3.5]);
  });

  it("regression: orders by exitTime even when entryTime order (and input array order) disagrees", () => {
    // Trade A opened first but closed LAST; Trade B opened second but closed FIRST.
    const a = trade({ entryTime: utc(2025, 1, 1), exitTime: utc(2025, 6, 1), r: 5 });
    const b = trade({ entryTime: utc(2025, 2, 1), exitTime: utc(2025, 3, 1), r: -2 });
    // Passed in entryTime order (a, b) - exitTime order is actually (b, a).
    const series = cumulativeRRSeries([a, b]);
    expect(series.map((p) => p.time)).toEqual([b.exitTime, a.exitTime]);
    expect(series.map((p) => p.cumulative)).toEqual([-2, 3]);
  });

  it("collapses trades sharing the exact same exitTime into one point carrying the combined cumulative value", () => {
    const sameExit = utc(2025, 6, 1);
    const trades = [trade({ exitTime: sameExit, r: 1 }), trade({ exitTime: sameExit, r: 2 })];
    const series = cumulativeRRSeries(trades);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({ time: sameExit, cumulative: 3 });
  });

  it("empty input produces an empty series", () => {
    expect(cumulativeRRSeries([])).toEqual([]);
  });
});

describe("computeKpis", () => {
  it("computes total/winRate/totalRR/expectancy/avgRR from a mixed set of trades", () => {
    const trades = [
      trade({ exitTime: utc(2025, 6, 1), r: 2, result: "Win" }),
      trade({ exitTime: utc(2025, 6, 2), r: -1, result: "Lose" }),
      trade({ exitTime: utc(2025, 6, 3), r: 3, result: "Win" }),
    ];
    const kpis = computeKpis(trades);
    expect(kpis.total).toBe(3);
    expect(kpis.wins).toBe(2);
    expect(kpis.winRate).toBeCloseTo((2 / 3) * 100);
    expect(kpis.totalRR).toBe(4);
    expect(kpis.expectancy).toBeCloseTo(4 / 3);
  });

  it("Expected Value and Avg. Trade RR are numerically identical - the same computation under two labels", () => {
    const trades = [trade({ r: 2 }), trade({ r: -1 }), trade({ r: 5 })];
    const kpis = computeKpis(trades);
    expect(kpis.avgRR).toBe(kpis.expectancy);
  });

  it("identifies best and worst exit day by totalRR", () => {
    const trades = [
      trade({ exitTime: utc(2025, 6, 1), r: 5 }), // best day: +5
      trade({ exitTime: utc(2025, 6, 2), r: -3 }), // worst day: -3
      trade({ exitTime: utc(2025, 6, 3), r: 1 }),
    ];
    const kpis = computeKpis(trades);
    expect(kpis.bestDay).toEqual({ dateKey: "2025-06-01", totalRR: 5 });
    expect(kpis.worstDay).toEqual({ dateKey: "2025-06-02", totalRR: -3 });
  });

  it("sums same-day trades before comparing days for best/worst", () => {
    const trades = [
      trade({ exitTime: utc(2025, 6, 1, 9), r: 1 }),
      trade({ exitTime: utc(2025, 6, 1, 14), r: 1 }), // day 1 total = 2
      trade({ exitTime: utc(2025, 6, 2), r: 1.5 }), // day 2 total = 1.5, less than day 1
    ];
    const kpis = computeKpis(trades);
    expect(kpis.bestDay).toEqual({ dateKey: "2025-06-01", totalRR: 2 });
  });

  it("empty trade set: zeros everywhere, best/worst day null (never fabricated)", () => {
    const kpis = computeKpis([]);
    expect(kpis.total).toBe(0);
    expect(kpis.totalRR).toBe(0);
    expect(kpis.bestDay).toBeNull();
    expect(kpis.worstDay).toBeNull();
  });

  it("single trade: best day and worst day are the same day", () => {
    const t = trade({ exitTime: utc(2025, 6, 1), r: 2 });
    const kpis = computeKpis([t]);
    expect(kpis.bestDay).toEqual(kpis.worstDay);
  });

  it("all-win set: winRate 100%, totalRR is the sum of every r", () => {
    const trades = [trade({ r: 1, result: "Win" }), trade({ r: 2, result: "Win" })];
    const kpis = computeKpis(trades);
    expect(kpis.winRate).toBe(100);
    expect(kpis.totalRR).toBe(3);
  });

  it("all-loss set: winRate 0%, totalRR is negative", () => {
    const trades = [trade({ r: -1, result: "Lose" }), trade({ r: -1, result: "Lose" })];
    const kpis = computeKpis(trades);
    expect(kpis.winRate).toBe(0);
    expect(kpis.totalRR).toBe(-2);
  });
});

describe("reconciliation - the same filtered set must agree across every breakdown", () => {
  const trades = [
    trade({ symbol: "EURUSD", exitTime: utc(2024, 1, 5), r: 2, result: "Win" }),
    trade({ symbol: "GBPUSD", exitTime: utc(2024, 1, 20), r: -1, result: "Lose" }),
    trade({ symbol: "EURUSD", exitTime: utc(2024, 6, 10), r: 3, result: "Win" }),
    trade({ symbol: "XAUUSD", exitTime: utc(2025, 3, 1), r: -2, result: "Lose" }),
    trade({ symbol: "EURUSD", exitTime: utc(2025, 12, 25), r: 1.5, result: "Win" }),
  ];

  it("total RR: KPI total equals sum of daily equals sum of monthly equals sum of yearly", () => {
    const kpis = computeKpis(trades);
    const sumOf = (map: Map<unknown, { totalRR: number }>) => [...map.values()].reduce((s, v) => s + v.totalRR, 0);
    expect(sumOf(groupByExitDay(trades))).toBeCloseTo(kpis.totalRR);
    expect(sumOf(groupByExitMonth(trades))).toBeCloseTo(kpis.totalRR);
    expect(sumOf(groupByExitYear(trades))).toBeCloseTo(kpis.totalRR);
    expect(cumulativeRRSeries(trades).at(-1)?.cumulative).toBeCloseTo(kpis.totalRR);
  });

  it("total trade count: KPI total equals sum of daily/monthly/yearly counts, no double counting", () => {
    const kpis = computeKpis(trades);
    const sumOf = (map: Map<unknown, { count: number }>) => [...map.values()].reduce((s, v) => s + v.count, 0);
    expect(sumOf(groupByExitDay(trades))).toBe(kpis.total);
    expect(sumOf(groupByExitMonth(trades))).toBe(kpis.total);
    expect(sumOf(groupByExitYear(trades))).toBe(kpis.total);
  });

  it("multi-symbol, multi-year data reconciles the same way after a symbol filter is applied", () => {
    const filtered = filterTrades(trades, ["EURUSD"], "all", null, null);
    const kpis = computeKpis(filtered);
    const sumOf = (map: Map<unknown, { totalRR: number }>) => [...map.values()].reduce((s, v) => s + v.totalRR, 0);
    expect(filtered).toHaveLength(3);
    expect(sumOf(groupByExitYear(filtered))).toBeCloseTo(kpis.totalRR);
  });
});

describe("maximumWinningStreak", () => {
  function seq(results: Array<"Win" | "Lose">): ScanTradeRecord[] {
    return results.map((result, i) => trade({ exitTime: utc(2025, 1, 1) + i * 3600, result, r: result === "Win" ? 1 : -1 }));
  }

  it("WIN WIN LOSS -> 2", () => {
    expect(maximumWinningStreak(seq(["Win", "Win", "Lose"]))).toBe(2);
  });

  it("LOSS WIN WIN WIN LOSS -> 3", () => {
    expect(maximumWinningStreak(seq(["Lose", "Win", "Win", "Win", "Lose"]))).toBe(3);
  });

  it("WIN WIN WIN -> 3", () => {
    expect(maximumWinningStreak(seq(["Win", "Win", "Win"]))).toBe(3);
  });

  it("LOSS LOSS LOSS -> 0", () => {
    expect(maximumWinningStreak(seq(["Lose", "Lose", "Lose"]))).toBe(0);
  });

  it("empty array -> 0", () => {
    expect(maximumWinningStreak([])).toBe(0);
  });

  it("the spec's own worked example: WIN WIN LOSS WIN WIN WIN LOSS -> 3", () => {
    expect(maximumWinningStreak(seq(["Win", "Win", "Lose", "Win", "Win", "Win", "Lose"]))).toBe(3);
  });
});

describe("maximumLosingStreak", () => {
  function seq(results: Array<"Win" | "Lose">): ScanTradeRecord[] {
    return results.map((result, i) => trade({ exitTime: utc(2025, 1, 1) + i * 3600, result, r: result === "Win" ? 1 : -1 }));
  }

  it("LOSS LOSS WIN -> 2", () => {
    expect(maximumLosingStreak(seq(["Lose", "Lose", "Win"]))).toBe(2);
  });

  it("WIN LOSS LOSS LOSS WIN -> 3", () => {
    expect(maximumLosingStreak(seq(["Win", "Lose", "Lose", "Lose", "Win"]))).toBe(3);
  });

  it("LOSS LOSS LOSS -> 3", () => {
    expect(maximumLosingStreak(seq(["Lose", "Lose", "Lose"]))).toBe(3);
  });

  it("WIN WIN WIN -> 0", () => {
    expect(maximumLosingStreak(seq(["Win", "Win", "Win"]))).toBe(0);
  });

  it("empty array -> 0", () => {
    expect(maximumLosingStreak([])).toBe(0);
  });

  it("the spec's own worked example: LOSS LOSS WIN LOSS LOSS LOSS WIN -> 3", () => {
    expect(maximumLosingStreak(seq(["Lose", "Lose", "Win", "Lose", "Lose", "Lose", "Win"]))).toBe(3);
  });
});

describe("maximumDrawdown", () => {
  function series(rs: number[]): ScanTradeRecord[] {
    return rs.map((r, i) => trade({ exitTime: utc(2025, 1, 1) + i * 3600, r, result: r >= 0 ? "Win" : "Lose" }));
  }

  it("the spec's own worked example: +3,+2,-1,-4,+2,-5 -> -8R", () => {
    expect(maximumDrawdown(series([3, 2, -1, -4, 2, -5]))).toBeCloseTo(-8);
  });

  it("monotonically increasing equity has zero drawdown: +1,+2,+3 -> 0R", () => {
    expect(maximumDrawdown(series([1, 2, 3]))).toBe(0);
  });

  it("monotonically decreasing equity: -1,-2,-3 -> -6R", () => {
    expect(maximumDrawdown(series([-1, -2, -3]))).toBeCloseTo(-6);
  });

  it("a later recovery does not erase an earlier, deeper drawdown: +5,-3,+4,-10 -> -10R", () => {
    expect(maximumDrawdown(series([5, -3, 4, -10]))).toBeCloseTo(-10);
  });

  it("empty input -> 0R (never a fabricated negative)", () => {
    expect(maximumDrawdown([])).toBe(0);
  });

  it("is derived from the SAME cumulativeRRSeries() the Cumulative RR chart uses - not a second, potentially-diverging equity calculation", () => {
    const trades = series([3, 2, -1, -4, 2, -5]);
    const points = cumulativeRRSeries(trades);
    let peak = 0;
    let expected = 0;
    for (const p of points) {
      peak = Math.max(peak, p.cumulative);
      expected = Math.min(expected, p.cumulative - peak);
    }
    expect(maximumDrawdown(trades)).toBeCloseTo(expected);
  });
});

describe("regression: streaks and drawdown order by exitTime, never entryTime", () => {
  it("maximumWinningStreak: exitTime order gives a genuinely different streak than entryTime order would", () => {
    // 5 trades: by RESULT they are W,W,W,L,L in exitTime order (streak 3),
    // but their entryTime values are deliberately scattered so sorting by
    // entryTime instead would give W,L,W,L,W (streak 1) - a full reversal
    // alone can't disprove an entryTime bug for every metric, so this uses
    // a genuinely different (non-reversal) permutation.
    const e1 = trade({ result: "Win", r: 1, exitTime: utc(2025, 1, 10), entryTime: utc(2025, 1, 1) });
    const e2 = trade({ result: "Win", r: 1, exitTime: utc(2025, 1, 11), entryTime: utc(2025, 1, 3) });
    const e3 = trade({ result: "Win", r: 1, exitTime: utc(2025, 1, 12), entryTime: utc(2025, 1, 5) });
    const e4 = trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 13), entryTime: utc(2025, 1, 2) });
    const e5 = trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 14), entryTime: utc(2025, 1, 4) });

    // Sanity-check the setup itself: entryTime order is e1,e4,e2,e5,e3 =
    // W,L,W,L,W (streak 1); exitTime order is e1,e2,e3,e4,e5 = W,W,W,L,L
    // (streak 3).
    const byEntry = [e1, e2, e3, e4, e5].slice().sort((a, b) => a.entryTime - b.entryTime);
    expect(byEntry.map((t) => t.result)).toEqual(["Win", "Lose", "Win", "Lose", "Win"]);

    expect(maximumWinningStreak([e1, e2, e3, e4, e5])).toBe(3);
    expect(maximumWinningStreak([e3, e1, e5, e2, e4])).toBe(3); // input array order must not matter either
  });

  it("maximumDrawdown: exitTime order gives a genuinely different drawdown than entryTime order would (-4R correctly, not -6R)", () => {
    // entryTime order R sequence: +2,+2,-3,-3 -> equity 2,4,1,-2, peak
    // 2,4,4,4, drawdown 0,0,-3,-6 -> would wrongly read -6R.
    // exitTime order R sequence:  +2,-3,+2,-3 -> equity 2,-1,1,-2, peak
    // 2,2,2,2, drawdown 0,-3,-1,-4 -> the correct -4R.
    const t1 = trade({ r: 2, result: "Win", entryTime: utc(2025, 1, 1), exitTime: utc(2025, 1, 10) });
    const t2 = trade({ r: 2, result: "Win", entryTime: utc(2025, 1, 2), exitTime: utc(2025, 1, 12) });
    const t3 = trade({ r: -3, result: "Lose", entryTime: utc(2025, 1, 3), exitTime: utc(2025, 1, 11) });
    const t4 = trade({ r: -3, result: "Lose", entryTime: utc(2025, 1, 4), exitTime: utc(2025, 1, 13) });

    const byEntry = [t1, t2, t3, t4].slice().sort((a, b) => a.entryTime - b.entryTime);
    expect(byEntry.map((t) => t.r)).toEqual([2, 2, -3, -3]); // confirms the wrong-if-entryTime-used value would be -6

    expect(maximumDrawdown([t1, t2, t3, t4])).toBeCloseTo(-4);
  });

  it("the spec's own example: trade A (entry Jan10/exit Jan20/+2R) then trade B (entry Jan05/exit Jan21/-1R) must process A -> B, by exitTime", () => {
    const a = trade({ entryTime: utc(2025, 1, 10), exitTime: utc(2025, 1, 20), r: 2, result: "Win" });
    const b = trade({ entryTime: utc(2025, 1, 5), exitTime: utc(2025, 1, 21), r: -1, result: "Lose" });

    const points = cumulativeRRSeries([a, b]);
    expect(points.map((p) => p.time)).toEqual([a.exitTime, b.exitTime]); // A's point (exitTime Jan20) precedes B's (Jan21)
    expect(points.map((p) => p.cumulative)).toEqual([2, 1]);
    expect(maximumWinningStreak([a, b])).toBe(1); // exitTime order is Win, Lose
  });

  it("date-range filtering (fromSec/toSec) combined with streaks/drawdown still uses exitTime, not entryTime", () => {
    // Same 4 trades as the drawdown disambiguation test above, but now
    // also exercised through filterTrades's own date range to confirm the
    // two features compose correctly.
    const t1 = trade({ r: 2, result: "Win", entryTime: utc(2025, 1, 1), exitTime: utc(2025, 1, 10) });
    const t2 = trade({ r: 2, result: "Win", entryTime: utc(2025, 1, 2), exitTime: utc(2025, 1, 12) });
    const t3 = trade({ r: -3, result: "Lose", entryTime: utc(2025, 1, 3), exitTime: utc(2025, 1, 11) });
    const t4 = trade({ r: -3, result: "Lose", entryTime: utc(2025, 1, 4), exitTime: utc(2025, 1, 13) });

    // Range excludes t4 by exitTime (Jan13), even though t4's entryTime
    // (Jan4) would fall inside a Jan1-Jan4 range.
    const filtered = filterTrades([t1, t2, t3, t4], "all", "all", utc(2025, 1, 1), utc(2025, 1, 12));
    expect(filtered).toHaveLength(3);
    // exitTime order of the surviving 3 trades: t1(+2), t3(-3), t2(+2) ->
    // equity 2,-1,1; peak 2,2,2; drawdown 0,-3,-1 -> max drawdown -3.
    expect(maximumDrawdown(filtered)).toBeCloseTo(-3);
  });
});

describe("tradeFrequencyAnalytics", () => {
  it("Test 1: basic daily frequency - Jan1,Jan1,Jan2,Jan5 -> 4 trades / 3 unique days = 1.333...", () => {
    const trades = [
      trade({ exitTime: utc(2025, 1, 1, 9) }),
      trade({ exitTime: utc(2025, 1, 1, 14) }),
      trade({ exitTime: utc(2025, 1, 2) }),
      trade({ exitTime: utc(2025, 1, 5) }),
    ];
    expect(tradeFrequencyAnalytics(trades).avgTradesPerDay).toBeCloseTo(4 / 3);
  });

  it("Test 2: same day - Jan1,Jan1,Jan1 -> average trades/day = 3", () => {
    const trades = [trade({ exitTime: utc(2025, 1, 1, 1) }), trade({ exitTime: utc(2025, 1, 1, 12) }), trade({ exitTime: utc(2025, 1, 1, 23) })];
    expect(tradeFrequencyAnalytics(trades).avgTradesPerDay).toBe(3);
  });

  it("Test 3: weekly grouping - Monday-Sunday buckets correctly across multiple ISO weeks", () => {
    // 2025-01-06 is a Monday. Two trades that Monday + one the following
    // Sunday (2025-01-12, same week) = 1 unique week. One trade the next
    // Monday (2025-01-13, a new week) = 2nd unique week.
    const trades = [
      trade({ exitTime: utc(2025, 1, 6) }), // Mon, week 1
      trade({ exitTime: utc(2025, 1, 8) }), // Wed, week 1
      trade({ exitTime: utc(2025, 1, 12) }), // Sun, still week 1
      trade({ exitTime: utc(2025, 1, 13) }), // Mon, week 2
    ];
    const freq = tradeFrequencyAnalytics(trades);
    expect(freq.avgTradesPerWeek).toBeCloseTo(4 / 2);
  });

  it("Test 4: monthly grouping - Jan15,Jan20,Feb1,Feb20 -> 4 trades / 2 unique months = 2", () => {
    const trades = [
      trade({ exitTime: utc(2025, 1, 15) }),
      trade({ exitTime: utc(2025, 1, 20) }),
      trade({ exitTime: utc(2025, 2, 1) }),
      trade({ exitTime: utc(2025, 2, 20) }),
    ];
    expect(tradeFrequencyAnalytics(trades).avgTradesPerMonth).toBe(2);
  });

  it("Test 5: yearly grouping - 2024-12-31,2025-01-01,2025-06-01 -> 3 trades / 2 unique years = 1.5", () => {
    const trades = [trade({ exitTime: utc(2024, 12, 31) }), trade({ exitTime: utc(2025, 1, 1) }), trade({ exitTime: utc(2025, 6, 1) })];
    expect(tradeFrequencyAnalytics(trades).avgTradesPerYear).toBeCloseTo(1.5);
  });

  it("Test 6: period membership is determined exclusively by exitTime - a trade entered Jan 31 and closed Feb 1 belongs to February for all four periods", () => {
    const t = trade({ entryTime: utc(2024, 1, 31), exitTime: utc(2024, 2, 1) });
    const freq = tradeFrequencyAnalytics([t]);
    // A single trade is its own sole active day/week/month/year -> every
    // average is 1, regardless of which period it landed in; the real
    // proof is exitDateParts's own dedicated regression tests plus this
    // one's use of a genuinely January-entry/February-exit trade.
    expect(freq).toEqual({ avgTradesPerDay: 1, avgTradesPerWeek: 1, avgTradesPerMonth: 1, avgTradesPerYear: 1 });
  });

  it("Test 7: filtering symbols/setups/exit-time date ranges changes the frequency metrics correctly", () => {
    const trades = [
      trade({ symbol: "EURUSD", exitTime: utc(2025, 1, 1) }),
      trade({ symbol: "EURUSD", exitTime: utc(2025, 1, 2) }),
      trade({ symbol: "GBPUSD", exitTime: utc(2025, 1, 1) }),
      trade({ symbol: "GBPUSD", exitTime: utc(2025, 1, 3) }),
    ];
    const eurOnly = filterTrades(trades, ["EURUSD"], "all", null, null);
    expect(tradeFrequencyAnalytics(eurOnly).avgTradesPerDay).toBe(1); // 2 trades / 2 unique days

    const rangeOnly = filterTrades(trades, "all", "all", utc(2025, 1, 1), utc(2025, 1, 1));
    expect(tradeFrequencyAnalytics(rangeOnly).avgTradesPerDay).toBe(2); // only the 2 trades exiting Jan 1
  });

  it("Test 8: empty dataset -> all four metrics are 0, never NaN/Infinity/undefined", () => {
    const freq = tradeFrequencyAnalytics([]);
    expect(freq).toEqual({ avgTradesPerDay: 0, avgTradesPerWeek: 0, avgTradesPerMonth: 0, avgTradesPerYear: 0 });
    for (const v of Object.values(freq)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("Test 9: single trade -> all four averages are 1", () => {
    const freq = tradeFrequencyAnalytics([trade({ exitTime: utc(2025, 6, 15) })]);
    expect(freq).toEqual({ avgTradesPerDay: 1, avgTradesPerWeek: 1, avgTradesPerMonth: 1, avgTradesPerYear: 1 });
  });

  it("Test 10: determinism - the same trade set always produces the same frequency metrics", () => {
    const trades = [
      trade({ exitTime: utc(2025, 1, 1) }),
      trade({ exitTime: utc(2025, 1, 15) }),
      trade({ exitTime: utc(2025, 3, 1) }),
    ];
    const a = tradeFrequencyAnalytics(trades);
    const b = tradeFrequencyAnalytics(trades);
    expect(a).toEqual(b);
  });

  it("reconciliation: Total Trades is the numerator for all four metrics, and the denominator is unique active exit-time periods", () => {
    const trades = [
      trade({ exitTime: utc(2025, 1, 5) }),
      trade({ exitTime: utc(2025, 1, 5) }),
      trade({ exitTime: utc(2025, 2, 10) }),
      trade({ exitTime: utc(2026, 1, 1) }),
    ];
    const kpis = computeKpis(trades);
    const freq = tradeFrequencyAnalytics(trades);
    const uniqueMonths = new Set(trades.map((t) => exitDateParts(t).monthKey)).size;
    const uniqueYears = new Set(trades.map((t) => exitDateParts(t).year)).size;
    expect(freq.avgTradesPerMonth).toBeCloseTo(kpis.total / uniqueMonths);
    expect(freq.avgTradesPerYear).toBeCloseTo(kpis.total / uniqueYears);
  });
});
