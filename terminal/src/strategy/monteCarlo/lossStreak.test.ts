import { describe, expect, it } from "vitest";
import { probabilityOfLossStreak, buildLossStreakMatrix, DEFAULT_LOSS_STREAK_WIN_RATES, DEFAULT_LOSS_STREAK_LENGTHS } from "./lossStreak";
import { createRng } from "./rng";

/** Brute-force P(max run of losses >= X) over all 2^n equally-likely
 * WIN/LOSS sequences (n small only) - the ground truth this module's DP
 * recurrence is checked against. Deliberately a completely independent
 * implementation (direct enumeration, no DP, no shared code with
 * lossStreak.ts) so it can't share a bug with the function under test. */
function bruteForceProbability(winRatePct: number, n: number, streakLength: number): number {
  const winProb = winRatePct / 100;
  let total = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let prob = 1;
    let maxStreak = 0;
    let current = 0;
    for (let i = 0; i < n; i++) {
      const isWin = (mask & (1 << i)) !== 0;
      prob *= isWin ? winProb : 1 - winProb;
      if (isWin) current = 0;
      else {
        current++;
        if (current > maxStreak) maxStreak = current;
      }
    }
    if (maxStreak >= streakLength) total += prob;
  }
  return total;
}

/** Monte Carlo cross-check, reusing the SAME seeded RNG the rest of this
 * module already uses (rng.ts's createRng) - never a second RNG. Not the
 * production calculation method (that's the DP above); only exists here to
 * validate the analytical formula empirically, per spec's "must be
 * validated against the exact analytical calculation" requirement. */
function monteCarloEstimate(winRatePct: number, n: number, streakLength: number, trials: number, seed: number): number {
  const rng = createRng(seed);
  const winProb = winRatePct / 100;
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    let current = 0;
    let maxStreak = 0;
    for (let i = 0; i < n; i++) {
      if (rng() < winProb) current = 0;
      else {
        current++;
        if (current > maxStreak) maxStreak = current;
      }
    }
    if (maxStreak >= streakLength) hits++;
  }
  return hits / trials;
}

describe("probabilityOfLossStreak - spec validation items", () => {
  it("1. X=1: P(at least 1 loss) = 1 - WR^N", () => {
    for (const wr of [10, 40, 70, 90]) {
      for (const n of [1, 5, 50]) {
        const expected = 1 - Math.pow(wr / 100, n);
        expect(probabilityOfLossStreak(wr, n, 1)).toBeCloseTo(expected, 10);
      }
    }
  });

  it("2. WR=100%: every streak probability is 0", () => {
    for (const x of [1, 2, 5, 10]) {
      expect(probabilityOfLossStreak(100, 1000, x)).toBe(0);
    }
  });

  it("3. WR=0%: every streak X<=N is 100%", () => {
    for (const x of [1, 2, 5, 10]) {
      expect(probabilityOfLossStreak(0, 10, x)).toBeCloseTo(1, 10);
    }
  });

  it("4. X>N: probability is 0", () => {
    expect(probabilityOfLossStreak(40, 5, 6)).toBe(0);
    expect(probabilityOfLossStreak(40, 3, 10)).toBe(0);
  });

  it("5. N=1, X=1: probability equals the loss probability exactly", () => {
    expect(probabilityOfLossStreak(40, 1, 1)).toBeCloseTo(0.6, 10);
    expect(probabilityOfLossStreak(72, 1, 1)).toBeCloseTo(0.28, 10);
  });

  it("6. matches brute-force enumeration for small N", () => {
    for (const wr of [20, 40, 60, 80]) {
      for (const n of [1, 4, 8, 12]) {
        for (const x of [1, 2, 3, n]) {
          if (x > n) continue;
          const expected = bruteForceProbability(wr, n, x);
          expect(probabilityOfLossStreak(wr, n, x)).toBeCloseTo(expected, 9);
        }
      }
    }
  });

  it("7. matches Monte Carlo estimate for a representative case (WR=40%, N=1000, X=5)", () => {
    const analytical = probabilityOfLossStreak(40, 1000, 5);
    const mc = monteCarloEstimate(40, 1000, 5, 20000, 42);
    // Binomial-proportion standard error at p~0.5, n=20000 is ~0.0035;
    // allow a generous 5-sigma band to keep this non-flaky.
    expect(Math.abs(analytical - mc)).toBeLessThan(0.02);
  });

  it("8. monotonicity: P(streak >= X) never increases as X increases (fixed WR/N)", () => {
    for (const wr of [30, 50, 70]) {
      let prev = 1;
      for (let x = 1; x <= 10; x++) {
        const p = probabilityOfLossStreak(wr, 1000, x);
        expect(p).toBeLessThanOrEqual(prev + 1e-9);
        prev = p;
      }
    }
  });

  it("9. monotonicity: losing-streak probability increases as WR decreases (fixed N/X)", () => {
    for (const x of [3, 5, 8]) {
      let prev = -1;
      for (const wr of [90, 70, 50, 30, 10]) {
        // iterating win rate DOWNWARD, so probability should be non-decreasing each step
        const p = probabilityOfLossStreak(wr, 1000, x);
        expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = p;
      }
    }
  });

  it("10. large N numerical stability - no NaN/Infinity, stays within [0,1]", () => {
    for (const wr of [1, 5, 50, 95, 99]) {
      for (const x of [1, 5, 10]) {
        const p = probabilityOfLossStreak(wr, 100000, x);
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("buildLossStreakMatrix", () => {
  it("produces the correct dimensions and percentage-scaled values", () => {
    const matrix = buildLossStreakMatrix({ winRatesPct: DEFAULT_LOSS_STREAK_WIN_RATES, sequenceLength: 1000, streakLengths: DEFAULT_LOSS_STREAK_LENGTHS });
    expect(matrix.probabilities.length).toBe(19);
    expect(matrix.probabilities[0].length).toBe(10);
    for (const row of matrix.probabilities) {
      for (const cell of row) {
        expect(cell).toBeGreaterThanOrEqual(0);
        expect(cell).toBeLessThanOrEqual(100);
      }
    }
  });

  it("each cell matches a direct probabilityOfLossStreak call (percentage-scaled)", () => {
    const matrix = buildLossStreakMatrix({ winRatesPct: [40], sequenceLength: 500, streakLengths: [1, 5] });
    expect(matrix.probabilities[0][0]).toBeCloseTo(probabilityOfLossStreak(40, 500, 1) * 100, 10);
    expect(matrix.probabilities[0][1]).toBeCloseTo(probabilityOfLossStreak(40, 500, 5) * 100, 10);
  });
});
