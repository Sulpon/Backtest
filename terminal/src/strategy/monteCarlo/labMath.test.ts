import { describe, expect, it } from "vitest";
import { breakevenWinRatePct, expectedValueR } from "./labMath";

describe("expectedValueR (spec item 12)", () => {
  it("WR=40%, Win=2.45R, Loss=1R -> +0.38R", () => {
    expect(expectedValueR(40, 2.45, 1)).toBeCloseTo(0.38, 4);
  });
});

describe("breakevenWinRatePct (spec item 13)", () => {
  it("Win=2.45R, Loss=1R -> ~28.99%", () => {
    expect(breakevenWinRatePct(2.45, 1)).toBeCloseTo(28.99, 1);
  });

  it("returns 0 rather than NaN when both are 0", () => {
    expect(breakevenWinRatePct(0, 0)).toBe(0);
  });
});
