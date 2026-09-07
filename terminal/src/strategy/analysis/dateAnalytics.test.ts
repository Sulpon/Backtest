import { describe, expect, it } from "vitest";
import {
  computeKpis,
  cumulativeRRSeries,
  exitDateParts,
  filterTrades,
  groupByExitDay,
  groupByExitMonth,
  groupByExitYear,
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
