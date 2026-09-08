import { describe, expect, it } from "vitest";
import { computeSymbolRobustness } from "./symbolRobustness";
import { makeTrade } from "./testFixtures";

describe("computeSymbolRobustness", () => {
  it("groups by symbol and computes per-symbol totalR/winRate", () => {
    const trades = [
      makeTrade({ symbol: "EURUSD", r: 2 }),
      makeTrade({ symbol: "EURUSD", r: -1 }),
      makeTrade({ symbol: "GBPUSD", r: 1 }),
    ];
    const result = computeSymbolRobustness(trades);
    const eur = result.bySymbol.find((s) => s.symbol === "EURUSD")!;
    const gbp = result.bySymbol.find((s) => s.symbol === "GBPUSD")!;
    expect(eur.trades).toBe(2);
    expect(eur.totalR).toBeCloseTo(1, 10);
    expect(eur.winRate).toBeCloseTo(50, 10);
    expect(gbp.trades).toBe(1);
    expect(gbp.totalR).toBeCloseTo(1, 10);
  });

  it("Symbol-Robustness scenario: a strategy profitable on 3/4 symbols reports 75% profitable", () => {
    const trades = [
      ...Array.from({ length: 5 }, () => makeTrade({ symbol: "EURUSD", r: 1 })),
      ...Array.from({ length: 5 }, () => makeTrade({ symbol: "GBPUSD", r: 1 })),
      ...Array.from({ length: 5 }, () => makeTrade({ symbol: "USDJPY", r: 1 })),
      ...Array.from({ length: 5 }, () => makeTrade({ symbol: "AUDUSD", r: -1 })),
    ];
    const result = computeSymbolRobustness(trades);
    expect(result.profitableSymbolsPct).toBeCloseTo(75, 10);
    expect(result.worstSymbolR).toBeCloseTo(-5, 10);
    expect(result.bestSymbolR).toBeCloseTo(5, 10);
    expect(result.medianSymbolR).toBeCloseTo(5, 10); // [-5,5,5,5] median of sorted middle two = (5+5)/2
  });

  it("dispersion is null for a single symbol (undefined for one sample)", () => {
    const trades = [makeTrade({ symbol: "EURUSD", r: 1 }), makeTrade({ symbol: "EURUSD", r: 2 })];
    expect(computeSymbolRobustness(trades).dispersion).toBeNull();
  });

  it("dispersion is null (not Infinity) when the mean across symbols is exactly 0", () => {
    const trades = [makeTrade({ symbol: "EURUSD", r: 5 }), makeTrade({ symbol: "GBPUSD", r: -5 })];
    expect(computeSymbolRobustness(trades).dispersion).toBeNull();
  });

  it("dispersion is a positive finite number for genuinely varied symbols", () => {
    const trades = [
      makeTrade({ symbol: "EURUSD", r: 10 }),
      makeTrade({ symbol: "GBPUSD", r: 1 }),
      makeTrade({ symbol: "USDJPY", r: 1 }),
    ];
    const d = computeSymbolRobustness(trades).dispersion;
    expect(d).not.toBeNull();
    expect(Number.isFinite(d)).toBe(true);
    expect(d as number).toBeGreaterThan(0);
  });

  it("empty input returns an empty, non-crashing result", () => {
    const result = computeSymbolRobustness([]);
    expect(result.bySymbol).toEqual([]);
    expect(result.profitableSymbolsPct).toBe(0);
    expect(result.dispersion).toBeNull();
  });
});
