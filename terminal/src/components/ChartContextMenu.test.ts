import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./ChartContextMenu";

describe("clampMenuPosition", () => {
  const viewport = { width: 1920, height: 1080 };

  it("leaves the menu exactly where it opened when it fits comfortably", () => {
    expect(clampMenuPosition(500, 300, 180, 200, viewport.width, viewport.height)).toEqual({ left: 500, top: 300 });
  });

  it("flips left when it would overflow the right edge", () => {
    const x = 1850; // 1850 + 180 = 2030 > 1920
    const result = clampMenuPosition(x, 300, 180, 200, viewport.width, viewport.height);
    expect(result.left).toBe(x - 180);
    expect(result.left + 180).toBeLessThanOrEqual(viewport.width);
  });

  it("flips up when it would overflow the bottom edge", () => {
    const y = 1000; // 1000 + 200 = 1200 > 1080
    const result = clampMenuPosition(500, y, 180, 200, viewport.width, viewport.height);
    expect(result.top).toBe(y - 200);
    expect(result.top + 200).toBeLessThanOrEqual(viewport.height);
  });

  it("flips both when opened in the bottom-right corner", () => {
    const result = clampMenuPosition(1900, 1070, 180, 200, viewport.width, viewport.height);
    expect(result.left).toBeLessThanOrEqual(viewport.width - 180);
    expect(result.top).toBeLessThanOrEqual(viewport.height - 200);
  });

  it("never places the menu at a negative coordinate even on a tiny viewport", () => {
    const result = clampMenuPosition(50, 50, 300, 300, 200, 200);
    expect(result.left).toBeGreaterThanOrEqual(0);
    expect(result.top).toBeGreaterThanOrEqual(0);
  });
});
