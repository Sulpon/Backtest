import { describe, expect, it } from "vitest";
import { generateWalkForwardFolds, runWalkForward } from "./walkForward";
import { computeCandidateMetrics } from "./metrics";
import { makeTrade } from "./testFixtures";
import type { ParameterCombination } from "./types";

describe("generateWalkForwardFolds", () => {
  it("1 fold reduces to exactly a 50/50 train/test split", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const folds = generateWalkForwardFolds(range, 1);
    expect(folds).toEqual([{ trainRange: { fromSec: 0, toSec: 500 }, testRange: { fromSec: 500, toSec: 1000 } }]);
  });

  it("produces an ANCHORED (expanding) train window across folds, never shrinking", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const folds = generateWalkForwardFolds(range, 3);
    expect(folds.length).toBe(3);
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].trainRange.toSec).toBeGreaterThan(folds[i - 1].trainRange.toSec);
      expect(folds[i].trainRange.fromSec).toBe(folds[0].trainRange.fromSec); // anchored at the same start
    }
  });

  it("each fold's test window starts exactly where its train window ends (no gap, no overlap)", () => {
    const range = { fromSec: 0, toSec: 1000 };
    const folds = generateWalkForwardFolds(range, 4);
    for (const f of folds) {
      expect(f.testRange.fromSec).toBe(f.trainRange.toSec);
    }
  });

  it("the last fold's test window ends exactly at the configured range end", () => {
    const range = { fromSec: 12345, toSec: 98765 };
    const folds = generateWalkForwardFolds(range, 5);
    expect(folds[folds.length - 1].testRange.toSec).toBe(range.toSec);
  });

  it("throws for fewer than 1 fold", () => {
    expect(() => generateWalkForwardFolds({ fromSec: 0, toSec: 1000 }, 0)).toThrow();
  });
});

const DAY = 86400;

function combo(key: string, value: number): ParameterCombination {
  return { key, values: { p: value }, isBaseline: false };
}

describe("runWalkForward", () => {
  it("Walk-Forward scenario: selects the genuinely better combo per fold using ONLY that fold's train window, never future data", () => {
    // Combo A is strong in the first half of the year, combo B strong in the
    // second half - a fold whose train window is entirely in the first half
    // must select A, entirely in the second half must select B. If any
    // future/test-window data leaked into selection, this would fail.
    const comboA = combo("a", 1);
    const comboB = combo("b", 2);

    const firstHalfWins = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: i * DAY, r: 1 }));
    const secondHalfLosses = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: (200 + i) * DAY, r: -1 }));
    const tradesA = [...firstHalfWins, ...secondHalfLosses];

    const firstHalfLosses = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: i * DAY, r: -1 }));
    const secondHalfWins = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: (200 + i) * DAY, r: 1 }));
    const tradesB = [...firstHalfLosses, ...secondHalfWins];

    const tradesByCombo = new Map([
      [comboA.key, tradesA],
      [comboB.key, tradesB],
    ]);

    const range = { fromSec: 0, toSec: 400 * DAY };
    const result = runWalkForward({
      combos: [comboA, comboB],
      tradesByCombo,
      range,
      folds: 1, // train = first half [0,200d], test = second half [200d,400d]
      minSampleSize: 1,
      selectionScoreOf: (trades) => computeCandidateMetrics(trades, 1).totalR,
    });

    expect(result.folds.length).toBe(1);
    // Train window (first half) favors combo A (all wins there) - selection
    // must be made using ONLY train-window trades.
    expect(result.folds[0].selectedParams).toEqual({ p: 1 });
    // But combo A's OWN test-window (second half) trades are losses - the
    // fold's testMetrics must reflect that reality, not the train result.
    expect(result.folds[0].testMetrics.totalR).toBeLessThan(0);
  });

  it("no future leakage: a fold's trainMetrics never include any trade whose exitTime falls in that fold's own test window", () => {
    const c = combo("a", 1);
    // +1s offset keeps every trade strictly off the fold boundary (20*DAY)
    // itself, so this test isolates leakage from the documented inclusive-
    // train-boundary convention (covered separately by trainTestSplit.test.ts).
    const trades = Array.from({ length: 40 }, (_, i) => makeTrade({ exitTime: i * DAY + 1, r: i < 20 ? 1 : -1 }));
    const range = { fromSec: 0, toSec: 40 * DAY };
    const result = runWalkForward({
      combos: [c],
      tradesByCombo: new Map([[c.key, trades]]),
      range,
      folds: 1,
      minSampleSize: 1,
      selectionScoreOf: (t) => computeCandidateMetrics(t, 1).totalR,
    });
    const fold = result.folds[0];
    // Train window [0,20d] is all wins (totalR=20); if any test-window loss
    // leaked in, totalR would be lower than exactly 20.
    expect(fold.trainMetrics.totalR).toBeCloseTo(20, 10);
    expect(fold.testMetrics.totalR).toBeCloseTo(-20, 10);
  });

  it("aggregates OOS metrics across every fold's own test-period trades", () => {
    const c = combo("a", 1);
    const trades = Array.from({ length: 30 }, (_, i) => makeTrade({ exitTime: i * DAY, r: 1 }));
    const range = { fromSec: 0, toSec: 30 * DAY };
    const result = runWalkForward({
      combos: [c],
      tradesByCombo: new Map([[c.key, trades]]),
      range,
      folds: 2,
      minSampleSize: 1,
      selectionScoreOf: (t) => computeCandidateMetrics(t, 1).totalR,
    });
    expect(result.totalFolds).toBe(2);
    // Every trade in a 3-window split lands in exactly one test window
    // except the first window (which is only ever a train window) - the
    // OOS total is the sum of whatever fell into test windows 2 and 3.
    const sumOfFoldTestR = result.folds.reduce((s, f) => s + f.testMetrics.totalR, 0);
    expect(result.oosTotalR).toBeCloseTo(sumOfFoldTestR, 10);
  });

  it("oosConsistencyPct reflects the fraction of folds with a profitable test period", () => {
    const winner = combo("win", 1);
    const loser = combo("lose", 2);
    // Only ever pick `winner` (score always higher), but give it alternating
    // profitable/unprofitable test windows across 2 folds.
    const tradesWin = [
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: i * DAY, r: 1 })), // fold0 train
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: (100 + i) * DAY, r: 1 })), // fold0 test: profitable
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: (200 + i) * DAY, r: -1 })), // fold1 test: unprofitable
    ];
    const tradesLose = Array.from({ length: 30 }, (_, i) => makeTrade({ exitTime: i * DAY, r: -100 }));
    const range = { fromSec: 0, toSec: 300 * DAY };
    const result = runWalkForward({
      combos: [winner, loser],
      tradesByCombo: new Map([
        [winner.key, tradesWin],
        [loser.key, tradesLose],
      ]),
      range,
      folds: 2,
      minSampleSize: 1,
      selectionScoreOf: (t) => computeCandidateMetrics(t, 1).totalR,
    });
    expect(result.oosConsistencyPct).toBeCloseTo(50, 10);
  });

  it("throws when there are no candidate combinations to select from", () => {
    expect(() =>
      runWalkForward({
        combos: [],
        tradesByCombo: new Map(),
        range: { fromSec: 0, toSec: 1000 },
        folds: 1,
        minSampleSize: 1,
        selectionScoreOf: () => 0,
      })
    ).toThrow();
  });
});
