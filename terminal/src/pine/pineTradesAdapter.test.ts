import { describe, expect, it } from "vitest";
import {
  collectPineTradesWithSource,
  groupPineTradesByIndicator,
  pineJournalSourceKey,
  pineTradeCompositeId,
} from "./pineTradesAdapter";
import type { PineIndicator } from "./pineIndicatorStore";
import type { PineRunResult } from "./usePineIndicators";
import type { CandleBar } from "../data/types";
import type { PineTradeRecord } from "./interpreter";

function bars(n: number, startTime = 1_700_000_000): CandleBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: startTime + i * 3600,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  }));
}

function indicator(overrides: Partial<PineIndicator> = {}): PineIndicator {
  return {
    id: "pi-1",
    name: "Test Indicator",
    code: "indicator('x')",
    visible: true,
    inputOverrides: {},
    startDate: null,
    ...overrides,
  };
}

function trade(overrides: Partial<PineTradeRecord> = {}): PineTradeRecord {
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

function result(overrides: Partial<PineRunResult> = {}, ind?: PineIndicator, trades: PineTradeRecord[] = [trade()]): PineRunResult {
  const windowedBars = bars(50);
  return {
    indicator: ind ?? indicator(),
    outputs: { lines: [], boxes: [], labels: [], plots: [], trades, errors: [] },
    inputDefs: [],
    fatalError: null,
    windowedBars,
    symbol: "EURUSD",
    timeframe: "1h",
    datasetVersion: "v1",
    ...overrides,
  };
}

describe("pineTradeCompositeId", () => {
  it("combines the indicator id and the raw trade id", () => {
    expect(pineTradeCompositeId("pi-1", "t5_10")).toBe("pi-1:t5_10");
  });

  it("produces distinct ids for two indicators sharing the exact same raw trade id", () => {
    const a = pineTradeCompositeId("pi-1", "t5_10");
    const b = pineTradeCompositeId("pi-2", "t5_10");
    expect(a).not.toBe(b);
  });
});

describe("collectPineTradesWithSource", () => {
  it("gives two indicators' trades with the same entryBar/exitBar distinct composite ids (no collision)", () => {
    const indA = indicator({ id: "pi-a", name: "A" });
    const indB = indicator({ id: "pi-b", name: "B" });
    const resA = result({}, indA, [trade({ id: "t5_10", entryBar: 5, exitBar: 10 })]);
    const resB = result({}, indB, [trade({ id: "t5_10", entryBar: 5, exitBar: 10 })]);

    const pairs = collectPineTradesWithSource([resA, resB], {});
    expect(pairs).toHaveLength(2);
    expect(pairs[0].id).not.toBe(pairs[1].id);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(2);
  });

  it("removing one indicator's trade via its composite id never hides another indicator's same-shaped trade", () => {
    const indA = indicator({ id: "pi-a", name: "A" });
    const indB = indicator({ id: "pi-b", name: "B" });
    const resA = result({}, indA, [trade({ id: "t5_10", entryBar: 5, exitBar: 10 })]);
    const resB = result({}, indB, [trade({ id: "t5_10", entryBar: 5, exitBar: 10 })]);

    const removed = { [pineTradeCompositeId("pi-a", "t5_10")]: true as const };
    const pairs = collectPineTradesWithSource([resA, resB], removed);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].source.indicator.id).toBe("pi-b");
  });

  it("returns an empty array for no results", () => {
    expect(collectPineTradesWithSource([], {})).toEqual([]);
  });
});

describe("groupPineTradesByIndicator", () => {
  it("buckets trades by their owning indicator rather than flattening them together", () => {
    const indA = indicator({ id: "pi-a", name: "A" });
    const indB = indicator({ id: "pi-b", name: "B" });
    const resA = result({}, indA, [trade({ id: "t1_2", entryBar: 1, exitBar: 2 }), trade({ id: "t3_4", entryBar: 3, exitBar: 4 })]);
    const resB = result({}, indB, [trade({ id: "t5_6", entryBar: 5, exitBar: 6 })]);

    const groups = groupPineTradesByIndicator([resA, resB], {});

    expect(groups).toHaveLength(2);
    expect(groups[0].indicator.id).toBe("pi-a");
    expect(groups[0].trades).toHaveLength(2);
    expect(groups[1].indicator.id).toBe("pi-b");
    expect(groups[1].trades).toHaveLength(1);
  });

  it("includes an indicator's group even when it has recorded zero trades", () => {
    const ind = indicator({ id: "pi-empty" });
    const res = result({}, ind, []);
    const groups = groupPineTradesByIndicator([res], {});
    expect(groups).toHaveLength(1);
    expect(groups[0].trades).toEqual([]);
  });

  it("respects the override store per-indicator, keyed by composite id", () => {
    const indA = indicator({ id: "pi-a" });
    const indB = indicator({ id: "pi-b" });
    const resA = result({}, indA, [trade({ id: "t5_10" })]);
    const resB = result({}, indB, [trade({ id: "t5_10" })]);

    const removed = { [pineTradeCompositeId("pi-a", "t5_10")]: true as const };
    const groups = groupPineTradesByIndicator([resA, resB], removed);

    expect(groups.find((g) => g.indicator.id === "pi-a")!.trades).toHaveLength(0);
    expect(groups.find((g) => g.indicator.id === "pi-b")!.trades).toHaveLength(1);
  });

  it("sorts each indicator's own trades chronologically by entry time", () => {
    const ind = indicator({ id: "pi-a" });
    const res = result({}, ind, [
      trade({ id: "t20_25", entryBar: 20, exitBar: 25 }),
      trade({ id: "t2_5", entryBar: 2, exitBar: 5 }),
    ]);
    const groups = groupPineTradesByIndicator([res], {});
    expect(groups[0].trades.map((p) => p.trade.entryBar)).toEqual([2, 20]);
  });
});

describe("pineJournalSourceKey", () => {
  it("namespaces the key so it can never collide with the literal backend source key", () => {
    expect(pineJournalSourceKey("backend")).not.toBe("backend");
    expect(pineJournalSourceKey("pi-1")).toBe("pine:pi-1");
  });
});
