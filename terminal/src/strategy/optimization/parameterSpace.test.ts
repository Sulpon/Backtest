import { describe, expect, it } from "vitest";
import {
  MAX_COMBINATIONS,
  buildParameterGrid,
  combinationKey,
  countCombinations,
  generateCombinations,
  gridNeighbors,
  valuesForParameter,
} from "./parameterSpace";
import type { ParameterDef } from "./types";

function def(key: string, current: number, min: number, max: number, step: number): ParameterDef {
  return { key, label: key, current, min, max, step };
}

describe("valuesForParameter", () => {
  it("generates an inclusive min..max range stepped by `step`", () => {
    expect(valuesForParameter(def("len", 20, 10, 20, 5))).toEqual([10, 15, 20]);
  });

  it("always includes `current` even when it doesn't land on a step", () => {
    const values = valuesForParameter(def("len", 27, 10, 30, 10));
    expect(values).toContain(27);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it("does not duplicate `current` when it already lands on a step", () => {
    const values = valuesForParameter(def("len", 20, 10, 30, 10));
    expect(values.filter((v) => v === 20).length).toBe(1);
  });

  it("handles fractional steps without floating-point drift", () => {
    const values = valuesForParameter(def("rr", 1, 1, 1.5, 0.1));
    expect(values).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5]);
  });

  it("throws for a non-positive step", () => {
    expect(() => valuesForParameter(def("len", 20, 10, 30, 0))).toThrow();
    expect(() => valuesForParameter(def("len", 20, 10, 30, -1))).toThrow();
  });

  it("throws when min > max", () => {
    expect(() => valuesForParameter(def("len", 20, 30, 10, 1))).toThrow();
  });

  it("a single-point range (min === max) returns exactly [current]", () => {
    expect(valuesForParameter(def("len", 20, 20, 20, 1))).toEqual([20]);
  });
});

describe("combinationKey", () => {
  it("is order-independent", () => {
    expect(combinationKey({ b: 2, a: 1 })).toBe(combinationKey({ a: 1, b: 2 }));
  });

  it("distinguishes different values", () => {
    expect(combinationKey({ a: 1 })).not.toBe(combinationKey({ a: 2 }));
  });
});

describe("countCombinations / generateCombinations", () => {
  it("counts the Cartesian product size without generating it", () => {
    const defs = [def("len", 20, 10, 20, 5), def("mult", 2, 1, 3, 1)];
    // len: [10,15,20] (3), mult: [1,2,3] (3) -> 9
    expect(countCombinations(defs)).toBe(9);
  });

  it("generateCombinations produces exactly countCombinations() entries, each unique", () => {
    const defs = [def("len", 20, 10, 20, 5), def("mult", 2, 1, 3, 1)];
    const combos = generateCombinations(defs);
    expect(combos.length).toBe(countCombinations(defs));
    const keys = new Set(combos.map((c) => c.key));
    expect(keys.size).toBe(combos.length);
  });

  it("marks exactly one combination as the baseline (all params at `current`)", () => {
    const defs = [def("len", 20, 10, 20, 5), def("mult", 2, 1, 3, 1)];
    const combos = generateCombinations(defs);
    const baselines = combos.filter((c) => c.isBaseline);
    expect(baselines.length).toBe(1);
    expect(baselines[0].values).toEqual({ len: 20, mult: 2 });
  });

  it("empty defs -> empty combinations (generateCombinations), but buildParameterGrid treats it as one baseline point", () => {
    expect(generateCombinations([])).toEqual([]);
  });

  it("single parameter produces one combination per value", () => {
    const combos = generateCombinations([def("len", 20, 10, 30, 10)]);
    expect(combos.map((c) => c.values.len)).toEqual([10, 20, 30]);
  });
});

describe("buildParameterGrid", () => {
  it("zero parameters returns exactly one baseline combination", () => {
    const result = buildParameterGrid([]);
    expect(result.blocked).toBe(false);
    expect(result.combinations.length).toBe(1);
    expect(result.combinations[0].isBaseline).toBe(true);
    expect(result.totalCombinations).toBe(1);
  });

  it("blocks (returns empty combinations + a message) when the grid exceeds MAX_COMBINATIONS", () => {
    // 200 * 200 = 40,000 > 10,000
    const defs = [def("a", 1, 1, 200, 1), def("b", 1, 1, 200, 1)];
    const result = buildParameterGrid(defs);
    expect(result.blocked).toBe(true);
    expect(result.combinations).toEqual([]);
    expect(result.totalCombinations).toBe(40_000);
    expect(result.blockedMessage).toContain("40,000");
    expect(result.blockedMessage).toContain(MAX_COMBINATIONS.toLocaleString("en-US"));
  });

  it("never silently truncates - a grid exactly at the ceiling is allowed in full", () => {
    // 100 * 100 = 10,000 = MAX_COMBINATIONS exactly
    const defs = [def("a", 1, 1, 100, 1), def("b", 1, 1, 100, 1)];
    const result = buildParameterGrid(defs);
    expect(result.blocked).toBe(false);
    expect(result.combinations.length).toBe(10_000);
  });

  it("a grid one over the ceiling is blocked, not truncated to the ceiling", () => {
    const defs = [def("a", 1, 1, 100, 1), def("b", 1, 1, 101, 1)]; // 100 * 101 = 10,100
    const result = buildParameterGrid(defs);
    expect(result.blocked).toBe(true);
    expect(result.totalCombinations).toBe(10_100);
  });
});

describe("gridNeighbors", () => {
  it("finds points exactly one step away in exactly one parameter", () => {
    const defs = [def("len", 20, 10, 30, 10), def("mult", 2, 1, 3, 1)];
    const combos = generateCombinations(defs);
    const center = combos.find((c) => c.values.len === 20 && c.values.mult === 2)!;
    const neighbors = gridNeighbors(center, combos, defs);
    const neighborTuples = neighbors.map((n) => `${n.values.len},${n.values.mult}`).sort();
    // (10,2) (30,2) (20,1) (20,3) - NOT (10,1) or (30,3) (those differ in both params)
    expect(neighborTuples).toEqual(["10,2", "20,1", "20,3", "30,2"]);
  });

  it("a corner point has fewer neighbors", () => {
    const defs = [def("len", 10, 10, 30, 10), def("mult", 1, 1, 3, 1)];
    const combos = generateCombinations(defs);
    const corner = combos.find((c) => c.values.len === 10 && c.values.mult === 1)!;
    const neighbors = gridNeighbors(corner, combos, defs);
    const neighborTuples = neighbors.map((n) => `${n.values.len},${n.values.mult}`).sort();
    expect(neighborTuples).toEqual(["10,2", "20,1"]);
  });

  it("a single-value parameter (min===max) contributes no neighbor axis", () => {
    const defs = [def("len", 20, 20, 20, 1), def("mult", 2, 1, 3, 1)];
    const combos = generateCombinations(defs);
    const center = combos.find((c) => c.values.len === 20 && c.values.mult === 2)!;
    const neighbors = gridNeighbors(center, combos, defs);
    expect(neighbors.map((n) => n.values.mult).sort()).toEqual([1, 3]);
  });
});
