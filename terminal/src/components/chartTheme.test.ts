import { describe, expect, it } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import { formatCrosshairTime } from "./chartTheme";

describe("formatCrosshairTime", () => {
  // 2026-09-09 14:00:00 UTC. Cast the same way ChartPane.tsx's own
  // asTime() helper does - Lightweight Charts' `Time` type is a union
  // (UTCTimestamp | BusinessDay | string), but every bar in this app is
  // always a plain unix-second number.
  const midday = 1788962400 as UTCTimestamp;
  // 2026-09-09 00:00:00 UTC - a daily bar's own bucket-start convention
  const midnight = 1788912000 as UTCTimestamp;

  it("shows date + time for intraday timeframes", () => {
    expect(formatCrosshairTime("1m", midday)).toBe("2026-09-09 14:00");
    expect(formatCrosshairTime("5m", midday)).toBe("2026-09-09 14:00");
    expect(formatCrosshairTime("15m", midday)).toBe("2026-09-09 14:00");
    expect(formatCrosshairTime("30m", midday)).toBe("2026-09-09 14:00");
    expect(formatCrosshairTime("1h", midday)).toBe("2026-09-09 14:00");
    expect(formatCrosshairTime("4h", midday)).toBe("2026-09-09 14:00");
  });

  it("shows date only for the daily timeframe, even at a non-midnight time", () => {
    expect(formatCrosshairTime("1d", midday)).toBe("2026-09-09");
  });

  it("daily formatting drops a midnight time component cleanly (no dangling ' 00:00')", () => {
    expect(formatCrosshairTime("1d", midnight)).toBe("2026-09-09");
  });

  it("intraday formatting still shows 00:00 explicitly when the hovered bar is at midnight", () => {
    expect(formatCrosshairTime("1h", midnight)).toBe("2026-09-09 00:00");
  });
});
