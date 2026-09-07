import { describe, expect, it } from "vitest";
import {
  evenlySpacedIndices,
  longestLoseStreak,
  longestWinStreak,
  nextOutcomeR,
  runMonteCarlo,
  statsFromRSequence,
} from "./engine";
import type { OutcomeSource, SimulationRunConfig } from "./types";

function config(overrides: Partial<SimulationRunConfig> = {}): SimulationRunConfig {
  return {
    numSimulations: 50,
    tradesPerSimulation: 30,
    seed: 12345,
    source: { kind: "simple", params: { winRatePct: 40, avgWinR: 2, avgLossR: 1 } },
    ...overrides,
  };
}

describe("runMonteCarlo - determinism (spec items 2-3)", () => {
  it("same seed + same inputs produce an identical result", () => {
    const a = runMonteCarlo(config());
    const b = runMonteCarlo(config());
    expect(Array.from(a.finalR)).toEqual(Array.from(b.finalR));
    expect(Array.from(a.maxDrawdownR)).toEqual(Array.from(b.maxDrawdownR));
    expect(a.representativePaths).toEqual(b.representativePaths);
  });

  it("a different seed produces a different result", () => {
    const a = runMonteCarlo(config({ seed: 1 }));
    const b = runMonteCarlo(config({ seed: 2 }));
    expect(Array.from(a.finalR)).not.toEqual(Array.from(b.finalR));
  });
});

describe("runMonteCarlo - counts respected (spec items 4-5)", () => {
  it("respects numSimulations", () => {
    const result = runMonteCarlo(config({ numSimulations: 137 }));
    expect(result.finalR.length).toBe(137);
    expect(result.maxDrawdownR.length).toBe(137);
    expect(result.maxWinningStreak.length).toBe(137);
  });

  it("respects tradesPerSimulation (every equity checkpoint/path is that long)", () => {
    const result = runMonteCarlo(config({ tradesPerSimulation: 64, numSimulations: 5 }));
    expect(Math.max(...result.checkpointTradeIndex)).toBe(63);
    for (const path of result.representativePaths) expect(path.length).toBe(64);
    for (const seq of result.retainedRSequences) expect(seq.length).toBe(64);
  });
});

describe("nextOutcomeR - bootstrap (spec items 6-7)", () => {
  it("samples only from the provided historical R outcomes", () => {
    const rHistory = [1.2, -1, 4.8, -1, 2.1];
    const source: OutcomeSource = { kind: "bootstrap", rHistory };
    const rng = () => Math.random();
    for (let i = 0; i < 200; i++) {
      expect(rHistory).toContain(nextOutcomeR(source, rng));
    }
  });

  it("handles an empty historical dataset without throwing (returns 0)", () => {
    const source: OutcomeSource = { kind: "bootstrap", rHistory: [] };
    expect(() => nextOutcomeR(source, () => 0.5)).not.toThrow();
    expect(nextOutcomeR(source, () => 0.5)).toBe(0);
  });
});

describe("Strategy Lab simple model (spec items 9-11)", () => {
  it("produces wins/losses in roughly the configured proportion over many draws", () => {
    const source: OutcomeSource = { kind: "simple", params: { winRatePct: 40, avgWinR: 2, avgLossR: 1 } };
    const rng = () => Math.random();
    let wins = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (nextOutcomeR(source, rng) > 0) wins++;
    expect(wins / n).toBeGreaterThan(0.37);
    expect(wins / n).toBeLessThan(0.43);
  });

  it("applies the configured average win exactly on a win", () => {
    const source: OutcomeSource = { kind: "simple", params: { winRatePct: 100, avgWinR: 2.45, avgLossR: 1 } };
    expect(nextOutcomeR(source, () => 0)).toBe(2.45);
  });

  it("applies the configured average loss exactly on a loss", () => {
    const source: OutcomeSource = { kind: "simple", params: { winRatePct: 0, avgWinR: 2.45, avgLossR: 1 } };
    expect(nextOutcomeR(source, () => 0.999999)).toBe(-1);
  });
});

describe("statsFromRSequence - drawdown (spec items 14-17)", () => {
  it("[+3,+2,-1,-4,+2,-5] -> -8R", () => {
    expect(statsFromRSequence([3, 2, -1, -4, 2, -5]).maxDrawdownR).toBe(-8);
  });
  it("[+1,+2,+3] -> 0R", () => {
    expect(statsFromRSequence([1, 2, 3]).maxDrawdownR).toBe(0);
  });
  it("[-1,-2,-3] -> -6R", () => {
    expect(statsFromRSequence([-1, -2, -3]).maxDrawdownR).toBe(-6);
  });
  it("[+5,-3,+4,-10] -> -10R", () => {
    // equity: 5, 2, 6, -4; peak: 5,5,6,6; drawdown: 0,-3,0,-10
    expect(statsFromRSequence([5, -3, 4, -10]).maxDrawdownR).toBe(-10);
  });
});

describe("longestWinStreak / longestLoseStreak (spec items 18-22)", () => {
  it("WIN WIN LOSS -> winning streak 2", () => {
    expect(longestWinStreak([1, 1, -1])).toBe(2);
  });
  it("LOSS WIN WIN WIN LOSS -> winning streak 3", () => {
    expect(longestWinStreak([-1, 1, 1, 1, -1])).toBe(3);
  });
  it("LOSS LOSS LOSS -> losing streak 3", () => {
    expect(longestLoseStreak([-1, -1, -1])).toBe(3);
  });
  it("WIN WIN WIN -> winning streak 3", () => {
    expect(longestWinStreak([1, 1, 1])).toBe(3);
  });
  it("empty -> 0", () => {
    expect(longestWinStreak([])).toBe(0);
    expect(longestLoseStreak([])).toBe(0);
  });
});

describe("evenlySpacedIndices", () => {
  it("always includes the last index", () => {
    expect(evenlySpacedIndices(1000, 10)).toContain(999);
  });
  it("returns every index once when count >= rangeLength", () => {
    expect(evenlySpacedIndices(5, 100)).toEqual([0, 1, 2, 3, 4]);
  });
  it("returns [] for a non-positive range", () => {
    expect(evenlySpacedIndices(0, 10)).toEqual([]);
  });
});
