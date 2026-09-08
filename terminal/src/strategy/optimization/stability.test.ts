import { describe, expect, it } from "vitest";
import { computeStability, findRobustRegion, ISOLATION_RATIO_THRESHOLD } from "./stability";
import { generateCombinations } from "./parameterSpace";
import type { ParameterDef, StabilityResult } from "./types";

function scoreMap(defs: ParameterDef[], scores: Record<number, number>) {
  // single-parameter helper: scores keyed by the parameter's own value
  const combos = generateCombinations(defs);
  const map = new Map(combos.map((c) => [c.key, scores[c.values[defs[0].key]]]));
  return { combos, scoreOf: (key: string) => map.get(key)! };
}

describe("computeStability - Overfitting/Plateau-vs-Spike methodology (item 35)", () => {
  // The module's own worked example: RR 2.0/2.2/2.4/2.6/2.8 -> 38/41/90/40/39R.
  const defs: ParameterDef[] = [{ key: "rr", label: "RR", current: 2.4, min: 2.0, max: 2.8, step: 0.2 }];
  const scores: Record<number, number> = { 2.0: 38, 2.2: 41, 2.4: 90, 2.6: 40, 2.8: 39 };
  const { combos, scoreOf } = scoreMap(defs, scores);

  it("flags the isolated spike (RR=2.4) as an isolated peak", () => {
    const spike = combos.find((c) => c.values.rr === 2.4)!;
    const result = computeStability(spike, combos, defs, scoreOf);
    expect(result.isIsolatedPeak).toBe(true);
    expect(result.isolationRatio!).toBeGreaterThan(ISOLATION_RATIO_THRESHOLD);
  });

  it("does NOT flag plateau members (RR=2.0, 2.2, 2.6, 2.8) as isolated peaks", () => {
    for (const rr of [2.0, 2.2, 2.6, 2.8]) {
      const combo = combos.find((c) => c.values.rr === rr)!;
      const result = computeStability(combo, combos, defs, scoreOf);
      expect(result.isIsolatedPeak).toBe(false);
    }
  });

  it("a rescaled version of the SAME shape (all scores x10) still isolates only the spike - methodology is scale-independent, not a hardcoded number", () => {
    const scaled: Record<number, number> = { 2.0: 380, 2.2: 410, 2.4: 900, 2.6: 400, 2.8: 390 };
    const { combos: c2, scoreOf: s2 } = scoreMap(defs, scaled);
    const spike = c2.find((c) => c.values.rr === 2.4)!;
    const plateauPoint = c2.find((c) => c.values.rr === 2.2)!;
    expect(computeStability(spike, c2, defs, s2).isIsolatedPeak).toBe(true);
    expect(computeStability(plateauPoint, c2, defs, s2).isIsolatedPeak).toBe(false);
  });

  it("a genuinely FLAT grid (no spike at all) flags nothing", () => {
    const flat: Record<number, number> = { 2.0: 50, 2.2: 51, 2.4: 49, 2.6: 50, 2.8: 50 };
    const { combos: c3, scoreOf: s3 } = scoreMap(defs, flat);
    for (const combo of c3) {
      expect(computeStability(combo, c3, defs, s3).isIsolatedPeak).toBe(false);
    }
  });

  it("a combination with no grid neighbors reports null/unmeasurable stability, never a false flag", () => {
    const single: ParameterDef[] = [{ key: "rr", label: "RR", current: 2.4, min: 2.4, max: 2.4, step: 1 }];
    const combos2 = generateCombinations(single);
    const result = computeStability(combos2[0], combos2, single, () => 999);
    expect(result.neighborAvgScore).toBeNull();
    expect(result.isolationRatio).toBeNull();
    expect(result.isIsolatedPeak).toBe(false);
  });
});

describe("findRobustRegion", () => {
  const defs: ParameterDef[] = [{ key: "rr", label: "RR", current: 2.4, min: 2.0, max: 2.8, step: 0.2 }];
  const scores: Record<number, number> = { 2.0: 38, 2.2: 41, 2.4: 90, 2.6: 40, 2.8: 39 };
  const { combos, scoreOf } = scoreMap(defs, scores);
  const stabilityMap = new Map(combos.map((c) => [c.key, computeStability(c, combos, defs, scoreOf)]));
  const stabilityOf = (key: string): StabilityResult => stabilityMap.get(key)!;

  it("the robust region's bar is set by the best NON-spike score, so the real plateau (2.0-2.8) is fully captured despite the 2.4 spike sitting inside it", () => {
    const region = findRobustRegion(combos, defs, scoreOf, stabilityOf);
    expect(region).not.toBeNull();
    expect(region!.ranges.rr).toEqual({ min: 2.0, max: 2.8 });
  });

  it("returns null (\"No stable parameter region detected\") when there are no parameters", () => {
    expect(findRobustRegion(combos, [], scoreOf, stabilityOf)).toBeNull();
  });

  it("a single combination (no neighbors, so never a spike) still yields a degenerate one-point region", () => {
    const single: ParameterDef[] = [{ key: "rr", label: "RR", current: 2.4, min: 2.4, max: 2.4, step: 1 }];
    const c4 = generateCombinations(single);
    const stabMap = new Map(c4.map((c) => [c.key, computeStability(c, c4, single, () => 999)]));
    const region = findRobustRegion(c4, single, () => 999, (k) => stabMap.get(k)!);
    expect(region!.ranges.rr).toEqual({ min: 2.4, max: 2.4 });
  });

  it("a flat grid (every point equally good) returns the full range as the robust region", () => {
    const flat: Record<number, number> = { 2.0: 50, 2.2: 50, 2.4: 50, 2.6: 50, 2.8: 50 };
    const { combos: c5, scoreOf: s5 } = scoreMap(defs, flat);
    const stabMap = new Map(c5.map((c) => [c.key, computeStability(c, c5, defs, s5)]));
    const region = findRobustRegion(c5, defs, s5, (k) => stabMap.get(k)!);
    expect(region!.ranges.rr).toEqual({ min: 2.0, max: 2.8 });
  });
});
