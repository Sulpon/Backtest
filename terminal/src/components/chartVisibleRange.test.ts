import { describe, expect, it } from "vitest";
import { defaultVisibleRangeIndices } from "./chartVisibleRange";

describe("defaultVisibleRangeIndices", () => {
  it("returns null for zero bars - the exact case that used to crash ChartPane", () => {
    expect(defaultVisibleRangeIndices(0)).toBeNull();
  });

  it("spans the whole dataset when it's smaller than the window", () => {
    expect(defaultVisibleRangeIndices(5, 300)).toEqual({ from: 0, to: 4 });
  });

  it("spans exactly the window when the dataset is larger", () => {
    expect(defaultVisibleRangeIndices(1000, 300)).toEqual({ from: 699, to: 999 });
  });

  it("handles a single bar", () => {
    expect(defaultVisibleRangeIndices(1)).toEqual({ from: 0, to: 0 });
  });
});
