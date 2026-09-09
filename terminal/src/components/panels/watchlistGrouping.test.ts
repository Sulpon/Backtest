import { describe, expect, it } from "vitest";
import { categorizeSymbol, groupSymbolsByCategory } from "./watchlistGrouping";

describe("categorizeSymbol", () => {
  it("classifies XAUUSD as Metals", () => {
    expect(categorizeSymbol("XAUUSD")).toBe("Metals");
  });

  it("classifies XAGUSD as Metals", () => {
    expect(categorizeSymbol("XAGUSD")).toBe("Metals");
  });

  it("classifies an ordinary forex pair as Forex", () => {
    expect(categorizeSymbol("EURUSD")).toBe("Forex");
    expect(categorizeSymbol("GBPJPY")).toBe("Forex");
  });

  it("does not false-positive on a symbol that merely contains XAU/XAG mid-string", () => {
    // Guards the startsWith choice specifically - a prefix match, not a substring match.
    expect(categorizeSymbol("USDXAU")).toBe("Forex");
  });
});

describe("groupSymbolsByCategory", () => {
  it("buckets rows by category, preserving each bucket's relative order", () => {
    const rows = [{ symbol: "EURUSD" }, { symbol: "XAUUSD" }, { symbol: "GBPUSD" }, { symbol: "XAGUSD" }];
    const grouped = groupSymbolsByCategory(rows);
    expect(grouped.map(([cat]) => cat)).toEqual(["Forex", "Metals"]);
    expect(grouped[0][1].map((r) => r.symbol)).toEqual(["EURUSD", "GBPUSD"]);
    expect(grouped[1][1].map((r) => r.symbol)).toEqual(["XAUUSD", "XAGUSD"]);
  });

  it("omits a category entirely when it has no rows", () => {
    const rows = [{ symbol: "EURUSD" }, { symbol: "GBPUSD" }];
    const grouped = groupSymbolsByCategory(rows);
    expect(grouped.map(([cat]) => cat)).toEqual(["Forex"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(groupSymbolsByCategory([])).toEqual([]);
  });
});
