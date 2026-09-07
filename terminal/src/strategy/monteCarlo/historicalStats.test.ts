import { describe, expect, it } from "vitest";
import { historicalRStats } from "./historicalStats";
import { computeKpis } from "../analysis/dateAnalytics";
import type { ScanTradeRecord } from "../types";

function utc(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour) / 1000);
}

function trade(overrides: Partial<ScanTradeRecord>): ScanTradeRecord {
  const entryTime = overrides.entryTime ?? utc(2025, 1, 1, 10);
  const exitTime = overrides.exitTime ?? entryTime + 3600;
  return {
    id: `t-${entryTime}-${exitTime}-${Math.random()}`,
    strategyId: "scan-1",
    indicatorId: "pi-1",
    symbol: "EURUSD",
    timeframe: "1h",
    dir: "long",
    entryTime,
    entryPrice: 1.1,
    sl: 1.09,
    tp: 1.12,
    exitTime,
    result: "Win",
    r: 1,
    setup: "OTE",
    ...overrides,
  };
}

describe("historicalRStats", () => {
  it("matches Detailed Analysis's computeKpis for total/winRate/expectancy (reconciliation)", () => {
    const trades = [
      trade({ result: "Win", r: 1.2, exitTime: utc(2025, 1, 1) }),
      trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 2) }),
      trade({ result: "Win", r: 4.8, exitTime: utc(2025, 1, 3) }),
      trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 4) }),
      trade({ result: "Win", r: 2.1, exitTime: utc(2025, 1, 5) }),
    ];
    const kpis = computeKpis(trades);
    const hist = historicalRStats(trades);
    expect(hist.count).toBe(kpis.total);
    expect(hist.winRate).toBe(kpis.winRate);
    expect(hist.expectancy).toBe(kpis.expectancy);
  });

  it("computes avgWinR/avgLossR as the mean magnitude of each side", () => {
    const trades = [
      trade({ result: "Win", r: 2, exitTime: utc(2025, 1, 1) }),
      trade({ result: "Win", r: 4, exitTime: utc(2025, 1, 2) }),
      trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 3) }),
      trade({ result: "Lose", r: -3, exitTime: utc(2025, 1, 4) }),
    ];
    const hist = historicalRStats(trades);
    expect(hist.avgWinR).toBe(3);
    expect(hist.avgLossR).toBe(2);
  });

  it("handles an empty trade set", () => {
    const hist = historicalRStats([]);
    expect(hist.count).toBe(0);
    expect(hist.avgWinR).toBe(0);
    expect(hist.avgLossR).toBe(0);
    expect(hist.rHistory).toEqual([]);
  });

  it("filters non-finite R values out of the bootstrap population (spec item 8)", () => {
    const trades = [
      trade({ result: "Win", r: 1, exitTime: utc(2025, 1, 1) }),
      trade({ result: "Win", r: NaN, exitTime: utc(2025, 1, 2) }),
      trade({ result: "Lose", r: -Infinity, exitTime: utc(2025, 1, 3) }),
      trade({ result: "Lose", r: -1, exitTime: utc(2025, 1, 4) }),
    ];
    const hist = historicalRStats(trades);
    expect(hist.rHistory).toEqual([1, -1]);
    expect(hist.rHistory.every(Number.isFinite)).toBe(true);
  });

  it("sorts rHistory by exitTime, not array/entryTime order", () => {
    const trades = [
      trade({ r: 2, exitTime: utc(2025, 3, 1), entryTime: utc(2025, 1, 1) }),
      trade({ r: 1, exitTime: utc(2025, 1, 1), entryTime: utc(2025, 3, 1) }),
    ];
    expect(historicalRStats(trades).rHistory).toEqual([1, 2]);
  });
});
