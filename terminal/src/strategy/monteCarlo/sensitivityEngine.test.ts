import { describe, expect, it } from "vitest";
import { runSensitivityMatrix } from "./sensitivityEngine";
import { expectedValueR } from "./labMath";
import { equityMultiplierForR } from "./riskEquity";
import type { SensitivityRunConfig } from "./sensitivityTypes";

function config(overrides: Partial<SensitivityRunConfig> = {}): SensitivityRunConfig {
  return {
    winRatePct: 40,
    tradesPerSimulation: 100,
    numSimulations: 2000,
    seed: 12345,
    startingBalance: 1000,
    axes: { riskLevelsPct: [0.5, 1, 2], rewardRiskRatios: [1, 2, 2.5] },
    ...overrides,
  };
}

describe("runSensitivityMatrix - grid generation", () => {
  it("produces matrix dimensions matching the configured axes", () => {
    const result = runSensitivityMatrix(config());
    expect(result.cells.length).toBe(3); // risk rows
    expect(result.cells[0].length).toBe(3); // rr columns
  });

  it("every cell's riskPct/rr matches its row/column axis value exactly", () => {
    const cfg = config({ axes: { riskLevelsPct: [0.25, 1.5], rewardRiskRatios: [0.5, 3] } });
    const result = runSensitivityMatrix(cfg);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        expect(result.cells[row][col].riskPct).toBe(cfg.axes.riskLevelsPct[row]);
        expect(result.cells[row][col].rr).toBe(cfg.axes.rewardRiskRatios[col]);
      }
    }
  });
});

describe("runSensitivityMatrix - deterministic edge cases (outcome model / final R / compounding)", () => {
  it("WR=100%: every trade wins, meanFinalR = rr * trades exactly, probability of profit = 100%", () => {
    const cfg = config({ winRatePct: 100, numSimulations: 50, tradesPerSimulation: 20, axes: { riskLevelsPct: [1, 2], rewardRiskRatios: [1.5, 2.5] } });
    const result = runSensitivityMatrix(cfg);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const cell = result.cells[row][col];
        expect(cell.meanFinalR).toBeCloseTo(cell.rr * 20, 9);
        expect(cell.medianFinalR).toBeCloseTo(cell.rr * 20, 9);
        expect(cell.probabilityOfProfitPct).toBe(100);
        // deterministic compounding: (1 + rr*risk/100)^trades exactly
        const expectedMultiplier = Math.pow(equityMultiplierForR(cell.rr, cell.riskPct), 20);
        expect(cell.meanFinalEquityMultiplier).toBeCloseTo(expectedMultiplier, 6);
      }
    }
  });

  it("WR=0%: every trade loses -1R, meanFinalR = -trades exactly, probability of profit = 0%", () => {
    const cfg = config({ winRatePct: 0, numSimulations: 50, tradesPerSimulation: 20, axes: { riskLevelsPct: [1, 2], rewardRiskRatios: [1.5, 2.5] } });
    const result = runSensitivityMatrix(cfg);
    for (const row of result.cells) {
      for (const cell of row) {
        expect(cell.meanFinalR).toBeCloseTo(-20, 9);
        expect(cell.probabilityOfProfitPct).toBe(0);
        const expectedMultiplier = Math.pow(equityMultiplierForR(-1, cell.riskPct), 20);
        expect(cell.meanFinalEquityMultiplier).toBeCloseTo(expectedMultiplier, 6);
      }
    }
  });

  it("meanFinalR and medianMaxDrawdownR are identical across every risk row within the same RR column (risk-size-agnostic R-space)", () => {
    const result = runSensitivityMatrix(config());
    for (let col = 0; col < result.rewardRiskRatios.length; col++) {
      const valuesInColumn = result.cells.map((row) => row[col].meanFinalR);
      expect(new Set(valuesInColumn.map((v) => v.toFixed(10))).size).toBe(1);
      const ddValuesInColumn = result.cells.map((row) => row[col].medianMaxDrawdownR);
      expect(new Set(ddValuesInColumn.map((v) => v.toFixed(10))).size).toBe(1);
    }
  });
});

describe("runSensitivityMatrix - reference validation example (WR=40%, Loss=1R, RR=2.5)", () => {
  it("simulated mean final R is close to the theoretical EV x trades (statistical, not exact)", () => {
    const cfg = config({ winRatePct: 40, tradesPerSimulation: 100, numSimulations: 20000, axes: { riskLevelsPct: [1], rewardRiskRatios: [2.5] } });
    const result = runSensitivityMatrix(cfg);
    const cell = result.cells[0][0];
    const theoreticalEv = expectedValueR(40, 2.5, 1); // +0.40R
    const theoreticalFinalR = theoreticalEv * 100; // +40R
    expect(theoreticalFinalR).toBeCloseTo(40, 6);
    // Simulated mean should be in the right ballpark of the theoretical
    // value - not exact (Monte Carlo noise), generous tolerance.
    expect(Math.abs(cell.meanFinalR - theoreticalFinalR)).toBeLessThan(3);
  });

  it("probability of profit is high and finite for a strongly positive-EV configuration", () => {
    const cfg = config({ winRatePct: 40, tradesPerSimulation: 100, numSimulations: 5000, axes: { riskLevelsPct: [1], rewardRiskRatios: [2.5] } });
    const result = runSensitivityMatrix(cfg);
    const cell = result.cells[0][0];
    expect(cell.probabilityOfProfitPct).toBeGreaterThan(90);
    expect(cell.probabilityOfProfitPct).toBeLessThanOrEqual(100);
    expect(Number.isFinite(cell.meanFinalEquityMultiplier)).toBe(true);
  });
});

describe("runSensitivityMatrix - determinism and common random numbers", () => {
  it("same seed + config => identical matrix", () => {
    const a = runSensitivityMatrix(config());
    const b = runSensitivityMatrix(config());
    expect(a.cells).toEqual(b.cells);
  });

  it("different seed => different result", () => {
    const a = runSensitivityMatrix(config({ seed: 1 }));
    const b = runSensitivityMatrix(config({ seed: 2 }));
    expect(a.cells[0][0].probabilityOfProfitPct).not.toBe(b.cells[0][0].probabilityOfProfitPct);
  });

  it("common random numbers: two columns with identical RR reproduce byte-identical cell stats (RNG resets per column)", () => {
    const cfg = config({
      winRatePct: 50,
      numSimulations: 500,
      tradesPerSimulation: 30,
      axes: { riskLevelsPct: [1], rewardRiskRatios: [1, 1] }, // two IDENTICAL columns
    });
    const result = runSensitivityMatrix(cfg);
    expect(result.cells[0][0]).toEqual(result.cells[0][1]);
  });
});
