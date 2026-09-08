import type { ParameterCombination, ParameterDef } from "./types";

/**
 * Parameter grid generation - a pure Cartesian-product builder over
 * ParameterDef[], with zero dependency on Pine/trade data. Mirrors this
 * project's established "narrow result type lives next to the function
 * that builds it" convention (see monteCarlo/lossStreak.ts's
 * LossStreakMatrixConfig/LossStreakMatrix) rather than centralizing every
 * shape in types.ts.
 */

/** Hard safety ceiling (per spec: "must BLOCK, never silently truncate").
 * Grid Search is a Cartesian product - a handful of parameters with a fine
 * step can explode combinatorially, and each combination costs one real
 * Pine run per symbol, so this must be checked BEFORE generation, not
 * after truncating a huge array down to size. */
export const MAX_COMBINATIONS = 10_000;

/** Defensive-only ceiling on a SINGLE parameter's own value count (min/max/
 * step misconfigured to something like step=0.0001 over a huge range) -
 * distinct from MAX_COMBINATIONS, which governs the product across all
 * parameters. Without this, valuesForParameter itself could build a
 * multi-million-element array before the product-level ceiling ever runs. */
const MAX_VALUES_PER_PARAMETER = 1_000_000;

function decimalPlaces(n: number): number {
  const s = n.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * The full set of values a single parameter sweeps, from `min` to `max`
 * inclusive in steps of `step`. `current` is always guaranteed to be a
 * member of the returned set - inserted (and the array re-sorted) if it
 * doesn't already land exactly on a step - so the mandatory baseline
 * combination (see buildParameterGrid) always exists as a real, searchable
 * grid point rather than being bolted on afterward.
 *
 * Values are rounded to the greater of `step`'s and `min`'s own decimal
 * precision to avoid classic floating-point accumulation drift (e.g.
 * 0.1 + 0.1 + 0.1 !== 0.3) when stepping through many iterations.
 */
export function valuesForParameter(def: ParameterDef): number[] {
  if (def.step <= 0) {
    throw new Error(`Parameter "${def.label}" has a non-positive step (${def.step}) - step must be greater than 0.`);
  }
  if (def.min > def.max) {
    throw new Error(`Parameter "${def.label}" has min (${def.min}) greater than max (${def.max}).`);
  }

  const decimals = Math.min(Math.max(decimalPlaces(def.step), decimalPlaces(def.min)), 10);
  const count = Math.floor((def.max - def.min) / def.step + 1e-9) + 1;
  if (count > MAX_VALUES_PER_PARAMETER) {
    throw new Error(
      `Parameter "${def.label}" would generate ${count.toLocaleString()} values between ${def.min} and ${def.max} with step ${def.step} - increase the step size.`
    );
  }

  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(Number((def.min + i * def.step).toFixed(decimals)));
  }
  if (!values.some((v) => Math.abs(v - def.current) < 1e-9)) {
    values.push(Number(def.current.toFixed(decimals)));
    values.sort((a, b) => a - b);
  }
  return values;
}

/** Total combination count for `defs` WITHOUT materializing the grid -
 * used to check MAX_COMBINATIONS before paying the cost of generation. */
export function countCombinations(defs: ParameterDef[]): number {
  if (defs.length === 0) return 1;
  return defs.reduce((acc, d) => acc * valuesForParameter(d).length, 1);
}

/** Deterministic, order-independent identity for a parameter combination -
 * sorted by key so `{b:2,a:1}` and `{a:1,b:2}` produce the same string.
 * Used for caching, the stability-heatmap's neighbor lookups, and
 * de-duplication. */
export function combinationKey(values: Record<string, number>): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k]}`)
    .join(",");
}

/** The full Cartesian product of every parameter's own valuesForParameter()
 * set. Does NOT check MAX_COMBINATIONS itself - callers needing the safety
 * ceiling should use buildParameterGrid, which checks countCombinations()
 * before calling this. `isBaseline` is true for exactly one combination:
 * the one where every parameter equals its own `current` value (guaranteed
 * to exist, per valuesForParameter's own doc comment). */
export function generateCombinations(defs: ParameterDef[]): ParameterCombination[] {
  if (defs.length === 0) return [];

  const axisValues = defs.map(valuesForParameter);
  const total = axisValues.reduce((acc, v) => acc * v.length, 1);
  const indices = new Array(defs.length).fill(0);
  const combinations: ParameterCombination[] = [];

  for (let n = 0; n < total; n++) {
    const values: Record<string, number> = {};
    let isBaseline = true;
    for (let p = 0; p < defs.length; p++) {
      const v = axisValues[p][indices[p]];
      values[defs[p].key] = v;
      if (Math.abs(v - defs[p].current) > 1e-9) isBaseline = false;
    }
    combinations.push({ key: combinationKey(values), values, isBaseline });

    for (let p = defs.length - 1; p >= 0; p--) {
      indices[p]++;
      if (indices[p] < axisValues[p].length) break;
      indices[p] = 0;
    }
  }
  return combinations;
}

export interface ParameterGridResult {
  combinations: ParameterCombination[];
  totalCombinations: number;
  /** True when totalCombinations exceeds MAX_COMBINATIONS - `combinations`
   * is empty in that case (never a silently truncated partial grid). */
  blocked: boolean;
  blockedMessage: string | null;
}

/**
 * The single entry point UI/orchestration code should call: computes the
 * total combination count first and BLOCKS (returns an empty grid plus an
 * explicit message) rather than truncating when it exceeds
 * MAX_COMBINATIONS, per spec. A zero-parameter config is treated as "just
 * the baseline" (one combination, the current live configuration) rather
 * than an error - a legitimate way to run robustness/Monte Carlo/walk-
 * forward analysis on the strategy as-is without searching anything.
 */
export function buildParameterGrid(defs: ParameterDef[]): ParameterGridResult {
  if (defs.length === 0) {
    return {
      combinations: [{ key: "", values: {}, isBaseline: true }],
      totalCombinations: 1,
      blocked: false,
      blockedMessage: null,
    };
  }

  const totalCombinations = countCombinations(defs);
  if (totalCombinations > MAX_COMBINATIONS) {
    return {
      combinations: [],
      totalCombinations,
      blocked: true,
      blockedMessage: `This parameter grid has ${totalCombinations.toLocaleString("en-US")} combinations, which exceeds the ${MAX_COMBINATIONS.toLocaleString("en-US")}-combination safety ceiling. Reduce the number of parameters, narrow the min/max ranges, or increase the step sizes.`,
    };
  }

  return { combinations: generateCombinations(defs), totalCombinations, blocked: false, blockedMessage: null };
}

/** Grid neighbors of `combo`: every OTHER combination in `all` that differs
 * from it in exactly one parameter, by exactly one step in that
 * parameter's own axis. Used by stability.ts to detect isolated peaks vs.
 * plateaus - a "neighbor" is defined structurally (one step away on the
 * searched grid), never by numeric distance across multiple parameters at
 * once, which would conflate unrelated axes. */
export function gridNeighbors(combo: ParameterCombination, all: ParameterCombination[], defs: ParameterDef[]): ParameterCombination[] {
  const axisValues = new Map(defs.map((d) => [d.key, valuesForParameter(d)]));
  const neighbors: ParameterCombination[] = [];

  for (const other of all) {
    if (other.key === combo.key) continue;
    let differingParams = 0;
    let isOneStepAway = false;
    for (const def of defs) {
      const a = combo.values[def.key];
      const b = other.values[def.key];
      if (Math.abs(a - b) < 1e-9) continue;
      differingParams++;
      if (differingParams > 1) break;
      const values = axisValues.get(def.key)!;
      const aIdx = values.findIndex((v) => Math.abs(v - a) < 1e-9);
      const bIdx = values.findIndex((v) => Math.abs(v - b) < 1e-9);
      isOneStepAway = aIdx >= 0 && bIdx >= 0 && Math.abs(aIdx - bIdx) === 1;
    }
    if (differingParams === 1 && isOneStepAway) neighbors.push(other);
  }
  return neighbors;
}
