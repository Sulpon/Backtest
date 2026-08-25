import { describe, expect, it } from "vitest";
import { LatestWins } from "./latestWins";

describe("LatestWins", () => {
  it("a fresh token is current", () => {
    const lw = new LatestWins();
    const a = lw.start();
    expect(a.isCurrent()).toBe(true);
  });

  it("an older token stops being current once a newer one starts", () => {
    const lw = new LatestWins();
    const a = lw.start();
    const b = lw.start();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
  });

  it("simulates the EURUSD -> GBPUSD -> XAUUSD race: only the last request wins even if it resolves first", async () => {
    const lw = new LatestWins();
    const applied: string[] = [];

    function fakeRequest(symbol: string, delayMs: number) {
      const token = lw.start();
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (token.isCurrent()) applied.push(symbol);
          resolve();
        }, delayMs);
      });
    }

    // A (EURUSD) is slow, B (GBPUSD) fast, C (XAUUSD) fastest - A resolves
    // LAST even though it started FIRST, and must never win.
    const a = fakeRequest("EURUSD", 30);
    const b = fakeRequest("GBPUSD", 10);
    const c = fakeRequest("XAUUSD", 5);
    await Promise.all([a, b, c]);

    expect(applied).toEqual(["XAUUSD"]);
  });

  it("many tokens in a row - only the final one is ever current", () => {
    const lw = new LatestWins();
    const tokens = Array.from({ length: 20 }, () => lw.start());
    tokens.slice(0, -1).forEach((t) => expect(t.isCurrent()).toBe(false));
    expect(tokens[tokens.length - 1].isCurrent()).toBe(true);
  });
});
