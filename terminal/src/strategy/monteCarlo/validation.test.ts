import { describe, expect, it } from "vitest";
import { validateLabParams } from "./validation";

function validParams() {
  return { winRatePct: 40, avgWinR: 2.45, avgLossR: 1, riskPct: 1, tradesPerSimulation: 100, numSimulations: 10000 };
}

describe("validateLabParams", () => {
  it("accepts a valid parameter set", () => {
    expect(validateLabParams(validParams()).valid).toBe(true);
  });

  it("rejects win rate outside (0, 100)", () => {
    expect(validateLabParams({ ...validParams(), winRatePct: 0 }).valid).toBe(false);
    expect(validateLabParams({ ...validParams(), winRatePct: 100 }).valid).toBe(false);
    expect(validateLabParams({ ...validParams(), winRatePct: 150 }).valid).toBe(false);
  });

  it("rejects non-positive average win/loss", () => {
    expect(validateLabParams({ ...validParams(), avgWinR: 0 }).valid).toBe(false);
    expect(validateLabParams({ ...validParams(), avgLossR: -1 }).valid).toBe(false);
  });

  it("rejects negative risk", () => {
    expect(validateLabParams({ ...validParams(), riskPct: -0.5 }).valid).toBe(false);
  });

  it("rejects non-positive trades/simulations counts", () => {
    expect(validateLabParams({ ...validParams(), tradesPerSimulation: 0 }).valid).toBe(false);
    expect(validateLabParams({ ...validParams(), numSimulations: 0 }).valid).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(validateLabParams({ ...validParams(), avgWinR: NaN }).valid).toBe(false);
    expect(validateLabParams({ ...validParams(), avgLossR: Infinity }).valid).toBe(false);
  });
});
