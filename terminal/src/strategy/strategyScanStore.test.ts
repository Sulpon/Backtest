import { beforeEach, describe, expect, it } from "vitest";
import { useStrategyScanStore } from "./strategyScanStore";
import type { ScanConfig, ScanTradeRecord } from "./types";

function config(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    startDate: 1_700_000_000,
    symbolMode: "all",
    customSymbols: [],
    timeframe: "1h",
    indicatorId: "pi-1",
    ...overrides,
  };
}

function trade(overrides: Partial<ScanTradeRecord> = {}): ScanTradeRecord {
  const symbol = overrides.symbol ?? "EURUSD";
  const timeframe = overrides.timeframe ?? "1h";
  const entryTime = overrides.entryTime ?? 1_700_000_000;
  const indicatorId = overrides.indicatorId ?? "pi-1";
  const exitTime = overrides.exitTime ?? entryTime + 3600;
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
    r: 1.5,
    setup: "BOS",
    ...overrides,
  };
}

describe("useStrategyScanStore", () => {
  beforeEach(() => {
    useStrategyScanStore.setState({ config: null, trades: {}, status: "idle", progress: [], lastRunAt: null });
  });

  describe("mergeTrades", () => {
    it("adds new trades keyed by id", () => {
      useStrategyScanStore.getState().mergeTrades([trade({ symbol: "EURUSD" }), trade({ symbol: "GBPUSD" })]);
      const trades = Object.values(useStrategyScanStore.getState().trades);
      expect(trades).toHaveLength(2);
      expect(trades.map((t) => t.symbol).sort()).toEqual(["EURUSD", "GBPUSD"]);
    });

    it("de-duplicates a re-run of the identical scan config - same id merged twice does not double the count", () => {
      const t = trade({ symbol: "EURUSD", entryTime: 1_700_000_000 });
      useStrategyScanStore.getState().mergeTrades([t]);
      useStrategyScanStore.getState().mergeTrades([t]);

      const trades = Object.values(useStrategyScanStore.getState().trades);
      expect(trades).toHaveLength(1);
    });

    it("overwrites (not duplicates) when the same id is merged with updated fields", () => {
      const original = trade({ result: "Win", r: 1.5 });
      const updated = { ...original, result: "Lose" as const, r: -1 };
      useStrategyScanStore.getState().mergeTrades([original]);
      useStrategyScanStore.getState().mergeTrades([updated]);

      const trades = Object.values(useStrategyScanStore.getState().trades);
      expect(trades).toHaveLength(1);
      expect(trades[0].result).toBe("Lose");
    });

    it("merges into existing trades from a prior run rather than clearing them", () => {
      useStrategyScanStore.getState().mergeTrades([trade({ symbol: "EURUSD" })]);
      useStrategyScanStore.getState().mergeTrades([trade({ symbol: "GBPUSD" })]);

      const trades = Object.values(useStrategyScanStore.getState().trades);
      expect(trades.map((t) => t.symbol).sort()).toEqual(["EURUSD", "GBPUSD"]);
    });

    it("distinguishes two indicators scanning the same symbol/timeframe/entryTime as separate trades", () => {
      useStrategyScanStore.getState().mergeTrades([trade({ indicatorId: "pi-a" }), trade({ indicatorId: "pi-b" })]);
      expect(Object.keys(useStrategyScanStore.getState().trades)).toHaveLength(2);
    });
  });

  describe("startScan", () => {
    it("seeds progress as pending for every given symbol and sets status to scanning", () => {
      useStrategyScanStore.getState().startScan(config(), ["EURUSD", "GBPUSD"]);
      const s = useStrategyScanStore.getState();
      expect(s.status).toBe("scanning");
      expect(s.progress).toEqual([
        { symbol: "EURUSD", status: "pending" },
        { symbol: "GBPUSD", status: "pending" },
      ]);
    });

    it("records the config used for this run", () => {
      const cfg = config({ timeframe: "4h" });
      useStrategyScanStore.getState().startScan(cfg, ["EURUSD"]);
      expect(useStrategyScanStore.getState().config).toEqual(cfg);
    });

    it("does not clear existing trades from a prior run", () => {
      useStrategyScanStore.getState().mergeTrades([trade({ symbol: "EURUSD" })]);
      useStrategyScanStore.getState().startScan(config(), ["GBPUSD"]);
      expect(Object.keys(useStrategyScanStore.getState().trades)).toHaveLength(1);
    });
  });

  describe("updateProgress", () => {
    it("patches only the matching symbol's entry", () => {
      useStrategyScanStore.getState().startScan(config(), ["EURUSD", "GBPUSD"]);
      useStrategyScanStore.getState().updateProgress("EURUSD", { status: "done", tradeCount: 3 });

      const progress = useStrategyScanStore.getState().progress;
      expect(progress.find((p) => p.symbol === "EURUSD")).toEqual({ symbol: "EURUSD", status: "done", tradeCount: 3 });
      expect(progress.find((p) => p.symbol === "GBPUSD")).toEqual({ symbol: "GBPUSD", status: "pending" });
    });
  });

  describe("finishScan", () => {
    it("sets the final status and records lastRunAt", () => {
      useStrategyScanStore.getState().startScan(config(), ["EURUSD"]);
      useStrategyScanStore.getState().finishScan("done");

      const s = useStrategyScanStore.getState();
      expect(s.status).toBe("done");
      expect(s.lastRunAt).not.toBeNull();
    });
  });

  describe("cancel", () => {
    it("flips status to cancelled while a scan is running", () => {
      useStrategyScanStore.getState().startScan(config(), ["EURUSD"]);
      useStrategyScanStore.getState().cancel();
      expect(useStrategyScanStore.getState().status).toBe("cancelled");
    });

    it("is a no-op when no scan is running", () => {
      useStrategyScanStore.getState().cancel();
      expect(useStrategyScanStore.getState().status).toBe("idle");
    });
  });
});
