import { describe, expect, it } from "vitest";
import { computeDegradationPct, splitTrainTest } from "./trainTestSplit";
import { makeTrade } from "./testFixtures";

describe("splitTrainTest", () => {
  it("splits a 0..1000 range at 70% into a 0..700 train / 700..1000 test boundary", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const result = splitTrainTest([], range, { trainPct: 70 });
    expect(result.trainRange).toEqual({ fromSec: 0, toSec: 700 });
    expect(result.testRange).toEqual({ fromSec: 700, toSec: 1000 });
  });

  it("Candidate A/B no-leakage case: every trade lands on exactly one side of the boundary, split by exitTime", () => {
    // Deliberately adversarial: entryTime is on the OTHER side of the
    // boundary from exitTime for both trades - if this function used
    // entryTime anywhere, these would land on the wrong side.
    const range = { fromSec: 0, toSec: 1000 };
    const trainSide = makeTrade({ entryTime: 650, exitTime: 699, r: 1 }); // entry inside test window, exit just before boundary
    const testSide = makeTrade({ entryTime: 690, exitTime: 701, r: -1 }); // entry just before boundary, exit just after
    const result = splitTrainTest([trainSide, testSide], range, { trainPct: 70 });
    expect(result.train.map((t) => t.id)).toEqual([trainSide.id]);
    expect(result.test.map((t) => t.id)).toEqual([testSide.id]);
  });

  it("a trade exactly on the boundary belongs to train (inclusive train, exclusive test)", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const onBoundary = makeTrade({ exitTime: 700, r: 1 });
    const result = splitTrainTest([onBoundary], range, { trainPct: 70 });
    expect(result.train.map((t) => t.id)).toEqual([onBoundary.id]);
    expect(result.test).toEqual([]);
  });

  it("train+test together account for every input trade exactly once", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const trades = [makeTrade({ exitTime: 100 }), makeTrade({ exitTime: 500 }), makeTrade({ exitTime: 900 })];
    const result = splitTrainTest(trades, range, { trainPct: 60 });
    expect(result.train.length + result.test.length).toBe(3);
    const ids = new Set([...result.train, ...result.test].map((t) => t.id));
    expect(ids.size).toBe(3);
  });

  it.each([50, 60, 70, 80] as const)("supports the %i%% configurable split", (trainPct) => {
    const range = { fromSec: 0, toSec: 1000 };
    const result = splitTrainTest([], range, { trainPct });
    expect(result.trainRange.toSec).toBeCloseTo(1000 * (trainPct / 100), 10);
  });
});

describe("computeDegradationPct", () => {
  it("computes % change from train to test", () => {
    expect(computeDegradationPct(2, 1)).toBeCloseTo(-50, 10);
    expect(computeDegradationPct(2, 3)).toBeCloseTo(50, 10);
  });

  it("handles a sign flip (positive train EV, negative test EV) correctly via abs(trainValue) denominator", () => {
    expect(computeDegradationPct(2, -1)).toBeCloseTo(-150, 10);
  });

  it("returns null (never Infinity/NaN) when trainValue is exactly 0", () => {
    expect(computeDegradationPct(0, 5)).toBeNull();
    expect(computeDegradationPct(0, 0)).toBeNull();
  });
});
