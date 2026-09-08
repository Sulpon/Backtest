import { describe, expect, it } from "vitest";
import { handleOptimizerRequest, type OptimizerWorkerRequest } from "./optimizer.worker";
import { generateCombinations } from "./parameterSpace";
import { makeTrade } from "./testFixtures";
import type { ParameterDef } from "./types";

describe("handleOptimizerRequest", () => {
  it("echoes the requestId and returns the same result runOptimizationEngine would produce directly", () => {
    const defs: ParameterDef[] = [{ key: "p", label: "P", current: 1, min: 1, max: 2, step: 1 }];
    const combos = generateCombinations(defs);
    const trades = Array.from({ length: 40 }, (_, i) => makeTrade({ exitTime: i * 3600, r: 1 }));
    const req: OptimizerWorkerRequest = {
      requestId: 7,
      input: {
        combos,
        defs,
        tradesByCombo: new Map(combos.map((c) => [c.key, trades])),
        range: { fromSec: 0, toSec: 40 * 3600 },
        trainTestSplit: { trainPct: 70 },
        minSampleSize: 5,
        walkForwardFolds: null,
        objective: "robustness",
      },
    };
    const response = handleOptimizerRequest(req);
    expect(response.requestId).toBe(7);
    expect(response.result.combinationsTested).toBe(combos.length);
    expect(response.result.baseline.combination.isBaseline).toBe(true);
  });
});
