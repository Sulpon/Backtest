import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSymbolDataMock, getOrComputeResultMock } = vi.hoisted(() => ({
  getSymbolDataMock: vi.fn(),
  getOrComputeResultMock: vi.fn(),
}));

vi.mock("../data/DataLayer", () => ({
  dataLayer: { getSymbolData: getSymbolDataMock },
}));

vi.mock("../pine/usePineIndicators", () => ({
  getOrComputeResult: getOrComputeResultMock,
}));

import { runHistoricalScan } from "./historicalScanner";
import { useStrategyScanStore } from "./strategyScanStore";
import type { ScanConfig } from "./types";
import type { PineIndicator } from "../pine/pineIndicatorStore";
import type { PineRunResult } from "../pine/usePineIndicators";
import type { CandleBar, SymbolTimeframeData } from "../data/types";
import type { PineTradeRecord } from "../pine/interpreter";

function bars(n: number, startTime = 1_700_000_000): CandleBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: startTime + i * 3600,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  }));
}

function symbolData(symbol: string, symbolBars: CandleBar[]): SymbolTimeframeData {
  return {
    symbol,
    timeframe: "1h",
    bars: symbolBars,
    swingPoints: [],
    bosEvents: [],
    fvgEvents: [],
    orderBlocks: [],
    volumeImbalanceEvents: [],
    liquidityEvents: [],
    trades: [],
    stats: null,
  };
}

function indicator(overrides: Partial<PineIndicator> = {}): PineIndicator {
  return { id: "pi-1", name: "Test", code: "indicator('x')", visible: true, inputOverrides: {}, startDate: null, ...overrides };
}

function pineTrade(overrides: Partial<PineTradeRecord> = {}): PineTradeRecord {
  return {
    id: "t5_10",
    dir: "long",
    entryBar: 5,
    entryPrice: 1.1,
    sl: 1.09,
    tp: 1.12,
    exitBar: 10,
    result: "Win",
    r: 1.5,
    setup: "BOS",
    ...overrides,
  };
}

function runResult(windowedBars: CandleBar[], trades: PineTradeRecord[], overrides: Partial<PineRunResult> = {}): PineRunResult {
  return {
    indicator: indicator(),
    outputs: { lines: [], boxes: [], labels: [], plots: [], trades, errors: [] },
    inputDefs: [],
    fatalError: null,
    windowedBars,
    symbol: null,
    timeframe: null,
    datasetVersion: "v1",
    ...overrides,
  };
}

function config(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return { startDate: 1_700_000_000, symbolMode: "all", customSymbols: [], timeframe: "1h", indicatorId: "pi-1", ...overrides };
}

describe("runHistoricalScan", () => {
  beforeEach(() => {
    useStrategyScanStore.setState({ config: null, trades: {}, status: "idle", progress: [], lastRunAt: null });
    getSymbolDataMock.mockReset();
    getOrComputeResultMock.mockReset();
  });

  it("converts each symbol's Pine trades to ScanTradeRecords tagged with that symbol, using real timestamps", async () => {
    const eurBars = bars(50);
    getSymbolDataMock.mockResolvedValue(symbolData("EURUSD", eurBars));
    getOrComputeResultMock.mockResolvedValue(runResult(eurBars, [pineTrade({ entryBar: 5, exitBar: 10 })]));

    await runHistoricalScan(config(), indicator(), ["EURUSD"]);

    const trades = Object.values(useStrategyScanStore.getState().trades);
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe("EURUSD");
    expect(trades[0].timeframe).toBe("1h");
    expect(trades[0].entryTime).toBe(eurBars[5].time);
    expect(trades[0].exitTime).toBe(eurBars[10].time);
  });

  it("runs every selected symbol and merges all into one combined collection", async () => {
    const eurBars = bars(50, 1_700_000_000);
    const gbpBars = bars(50, 1_650_000_000);
    getSymbolDataMock.mockImplementation(async (symbol: string) => symbolData(symbol, symbol === "EURUSD" ? eurBars : gbpBars));
    getOrComputeResultMock.mockImplementation(async (_ind: PineIndicator, symbolBars: CandleBar[]) =>
      runResult(symbolBars, [pineTrade({ entryBar: 5, exitBar: 10 })])
    );

    await runHistoricalScan(config(), indicator(), ["EURUSD", "GBPUSD"]);

    const trades = Object.values(useStrategyScanStore.getState().trades);
    expect(trades.map((t) => t.symbol).sort()).toEqual(["EURUSD", "GBPUSD"]);
  });

  it("regression: two trades sharing the same entry bar but different exit bars are both preserved, not collapsed into one (live-validation finding: a real scan produced 107 interpreter trades but only 90 survived storage until ScanTradeRecord.id included exitTime)", async () => {
    const eurBars = bars(300);
    getSymbolDataMock.mockResolvedValue(symbolData("EURUSD", eurBars));
    // Mirrors the real collision found live: a same-bar-exit trade
    // (entryBar 179, exitBar 179) alongside a separately-running trade that
    // also opened on bar 179 but exited later (exitBar 231) - same
    // entryTime, different exitTime, different direction/price/result.
    getOrComputeResultMock.mockResolvedValue(
      runResult(eurBars, [
        pineTrade({ id: "t179_179", entryBar: 179, exitBar: 179, dir: "short", entryPrice: 1.021554, result: "Win", r: 2.45 }),
        pineTrade({ id: "t179_231", entryBar: 179, exitBar: 231, dir: "long", entryPrice: 1.021554, result: "Win", r: 2.45 }),
      ])
    );

    await runHistoricalScan(config(), indicator(), ["EURUSD"]);

    const trades = Object.values(useStrategyScanStore.getState().trades);
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.dir).sort()).toEqual(["long", "short"]);
    expect(new Set(trades.map((t) => t.id)).size).toBe(2);
  });

  it("re-running the identical scan config does not duplicate trades", async () => {
    const eurBars = bars(50);
    getSymbolDataMock.mockResolvedValue(symbolData("EURUSD", eurBars));
    getOrComputeResultMock.mockResolvedValue(runResult(eurBars, [pineTrade({ entryBar: 5, exitBar: 10 })]));

    const cfg = config();
    await runHistoricalScan(cfg, indicator(), ["EURUSD"]);
    await runHistoricalScan(cfg, indicator(), ["EURUSD"]);

    expect(Object.keys(useStrategyScanStore.getState().trades)).toHaveLength(1);
  });

  it("overrides startDate on a local copy of the indicator, never mutating the caller's own object", async () => {
    const eurBars = bars(50);
    getSymbolDataMock.mockResolvedValue(symbolData("EURUSD", eurBars));
    getOrComputeResultMock.mockResolvedValue(runResult(eurBars, []));

    const ind = indicator({ startDate: null });
    await runHistoricalScan(config({ startDate: 1_699_000_000 }), ind, ["EURUSD"]);

    expect(ind.startDate).toBeNull();
    expect(getOrComputeResultMock).toHaveBeenCalledWith(expect.objectContaining({ startDate: 1_699_000_000 }), eurBars, "EURUSD", "1h");
  });

  it("continues to the next symbol when one symbol's run fails, marking only that symbol as an error", async () => {
    const gbpBars = bars(50, 1_650_000_000);
    getSymbolDataMock.mockImplementation(async (symbol: string) => {
      if (symbol === "EURUSD") throw new Error("network down");
      return symbolData(symbol, gbpBars);
    });
    getOrComputeResultMock.mockResolvedValue(runResult(gbpBars, [pineTrade({ entryBar: 5, exitBar: 10 })]));

    await runHistoricalScan(config(), indicator(), ["EURUSD", "GBPUSD"]);

    const s = useStrategyScanStore.getState();
    expect(s.progress.find((p) => p.symbol === "EURUSD")).toMatchObject({ status: "error" });
    expect(s.progress.find((p) => p.symbol === "GBPUSD")).toMatchObject({ status: "done" });
    expect(Object.values(s.trades).map((t) => t.symbol)).toEqual(["GBPUSD"]);
  });

  it("marks the scan status 'done' after every symbol completes", async () => {
    const eurBars = bars(50);
    getSymbolDataMock.mockResolvedValue(symbolData("EURUSD", eurBars));
    getOrComputeResultMock.mockResolvedValue(runResult(eurBars, []));

    await runHistoricalScan(config(), indicator(), ["EURUSD"]);

    expect(useStrategyScanStore.getState().status).toBe("done");
  });
});
