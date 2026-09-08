import { describe, expect, it } from "vitest";
import { runOptimizationEngine } from "./optimizationEngine";
import { generateCombinations } from "./parameterSpace";
import { makeTrade } from "./testFixtures";
import type { ParameterDef } from "./types";

const DAY = 86400;

function baseInput(overrides: Partial<Parameters<typeof runOptimizationEngine>[0]> = {}) {
  const defs: ParameterDef[] = [{ key: "p", label: "P", current: 2, min: 1, max: 3, step: 1 }];
  const combos = generateCombinations(defs);
  return {
    combos,
    defs,
    tradesByCombo: new Map<string, ReturnType<typeof makeTrade>[]>(),
    range: { fromSec: 0, toSec: 1000 * DAY },
    trainTestSplit: { trainPct: 70 as const },
    minSampleSize: 5,
    walkForwardFolds: null,
    objective: "robustness" as const,
    ...overrides,
  };
}

describe("runOptimizationEngine - item 34: No-Data-Leakage", () => {
  it("candidates with identical TRAIN trades but wildly different TEST trades get identical Robustness Scores", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 2, step: 1 }];
    const combos = generateCombinations(defs);
    const [comboA, comboB] = combos;

    // TRAIN window (first 700 days of 1000): identical 40 winning trades for both.
    const sharedTrain = Array.from({ length: 40 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 }));
    // TEST window (last 300 days): wildly different - A profitable, B a disaster.
    const testA = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: 750 * DAY + i * DAY, r: 2 }));
    const testB = Array.from({ length: 20 }, (_, i) => makeTrade({ exitTime: 750 * DAY + i * DAY, r: -5 }));

    const result = runOptimizationEngine(
      baseInput({
        combos,
        defs,
        tradesByCombo: new Map([
          [comboA.key, [...sharedTrain, ...testA]],
          [comboB.key, [...sharedTrain, ...testB]],
        ]),
      })
    );

    const candA = result.candidates.find((c) => c.combination.key === comboA.key)!;
    const candB = result.candidates.find((c) => c.combination.key === comboB.key)!;
    expect(candA.robustness.total).toBeCloseTo(candB.robustness.total, 10);
    expect(candA.trainMetrics.totalR).toBeCloseTo(candB.trainMetrics.totalR, 10);
    // But their TEST-period results (never used for scoring) genuinely differ.
    expect(candA.testMetrics.totalR).not.toBeCloseTo(candB.testMetrics.totalR, 1);
  });
});

describe("runOptimizationEngine - item 35: Overfitting/Plateau-vs-Spike", () => {
  it("an isolated single-parameter spike scores lower and carries a warning, despite the highest raw Train Total R", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 3, min: 1, max: 5, step: 1 }];
    const combos = generateCombinations(defs);
    // Total R per combo (train window, first 700 days): 38,41,90,40,39 - the module's own worked example.
    const scoreFor: Record<number, number> = { 1: 38, 2: 41, 3: 90, 4: 40, 5: 39 };
    const tradesByCombo = new Map(
      combos.map((c) => [
        c.key,
        Array.from({ length: scoreFor[c.values.p] }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 })),
      ])
    );
    const result = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo, minSampleSize: 1 }));

    const spike = result.candidates.find((c) => c.combination.values.p === 3)!;
    const plateauNeighbor = result.candidates.find((c) => c.combination.values.p === 2)!;
    expect(spike.stability.isIsolatedPeak).toBe(true);
    expect(spike.warnings.some((w) => w.message.toLowerCase().includes("isolated"))).toBe(true);
    expect(spike.trainMetrics.totalR).toBeGreaterThan(plateauNeighbor.trainMetrics.totalR); // raw historical peak
    expect(spike.robustness.total).toBeLessThan(plateauNeighbor.robustness.total); // yet scores lower
  });
});

describe("runOptimizationEngine - item 36: Minimum-Trade", () => {
  it("a candidate below the minimum sample size is marked insufficientSample and excluded from `ranked`, but stays visible in `candidates`", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 2, step: 1 }];
    const combos = generateCombinations(defs);
    const [tiny, ample] = combos;
    const tradesByCombo = new Map([
      [tiny.key, Array.from({ length: 3 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 5 }))], // huge EV, tiny sample
      [ample.key, Array.from({ length: 50 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 }))],
    ]);
    const result = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo, minSampleSize: 30 }));

    const tinyResult = result.candidates.find((c) => c.combination.key === tiny.key)!;
    expect(tinyResult.trainMetrics.insufficientSample).toBe(true);
    expect(result.ranked.some((c) => c.combination.key === tiny.key)).toBe(false);
    expect(result.candidates.some((c) => c.combination.key === tiny.key)).toBe(true);
    expect(result.insufficientSampleCount).toBeGreaterThanOrEqual(1);
  });
});

describe("runOptimizationEngine - item 37: Symbol-Robustness", () => {
  it("a candidate profitable on only some symbols reports the correct profitableSymbolsPct and a symbol-consistency warning", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 1, step: 1 }];
    const combos = generateCombinations(defs);
    const combo = combos[0];
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ symbol: "EURUSD", exitTime: i * DAY, r: 1 })),
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ symbol: "GBPUSD", exitTime: 100 * DAY + i * DAY, r: 1 })),
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ symbol: "USDJPY", exitTime: 200 * DAY + i * DAY, r: -1 })),
      ...Array.from({ length: 10 }, (_, i) => makeTrade({ symbol: "AUDUSD", exitTime: 300 * DAY + i * DAY, r: -1 })),
    ];
    const result = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo: new Map([[combo.key, trades]]), minSampleSize: 1 }));

    const cand = result.candidates[0];
    expect(cand.symbolRobustness.profitableSymbolsPct).toBeCloseTo(50, 10);
    expect(cand.warnings.some((w) => w.message.includes("symbols"))).toBe(true);
  });
});

describe("runOptimizationEngine - item 38: Walk-Forward", () => {
  it("populates walkForward with the requested fold count when walkForwardFolds is set, and null when omitted", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 1, step: 1 }];
    const combos = generateCombinations(defs);
    const trades = Array.from({ length: 60 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 }));
    const tradesByCombo = new Map([[combos[0].key, trades]]);

    const withWf = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo, minSampleSize: 1, walkForwardFolds: 3 }));
    expect(withWf.walkForward).not.toBeNull();
    expect(withWf.walkForward!.totalFolds).toBe(3);

    const withoutWf = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo, minSampleSize: 1, walkForwardFolds: null }));
    expect(withoutWf.walkForward).toBeNull();
  });
});

describe("runOptimizationEngine - general behavior", () => {
  it("always identifies exactly one baseline candidate", () => {
    const result = runOptimizationEngine(baseInput());
    expect(result.baseline.combination.isBaseline).toBe(true);
  });

  it("ranking respects the selected objective (oosTotalR sorts strictly by Test Total R)", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 2, step: 1 }];
    const combos = generateCombinations(defs);
    const [low, high] = combos;
    const tradesByCombo = new Map([
      [low.key, [
        ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 })),
        ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: 750 * DAY + i * DAY, r: 0.1 })),
      ]],
      [high.key, [
        ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: i * 10 * DAY, r: 1 })),
        ...Array.from({ length: 10 }, (_, i) => makeTrade({ exitTime: 750 * DAY + i * DAY, r: 5 })),
      ]],
    ]);
    const result = runOptimizationEngine(baseInput({ combos, defs, tradesByCombo, minSampleSize: 1, objective: "oosTotalR" }));
    expect(result.ranked[0].combination.key).toBe(high.key);
  });
});
