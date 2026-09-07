import { describe, expect, it } from "vitest";
import { createRng } from "./rng";

describe("createRng", () => {
  it("is deterministic: the same seed produces the same sequence of draws", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const drawsA = Array.from({ length: 20 }, () => a());
    const drawsB = Array.from({ length: 20 }, () => b());
    expect(drawsA).toEqual(drawsB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = createRng(12345);
    const b = createRng(54321);
    const drawsA = Array.from({ length: 20 }, () => a());
    const drawsB = Array.from({ length: 20 }, () => b());
    expect(drawsA).not.toEqual(drawsB);
  });

  it("always returns values in [0, 1)", () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("handles negative and fractional seeds without throwing", () => {
    expect(() => createRng(-42)()).not.toThrow();
    expect(() => createRng(3.14)()).not.toThrow();
  });
});
