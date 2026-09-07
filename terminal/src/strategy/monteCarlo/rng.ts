import type { Rng } from "./types";

/**
 * Deterministic seeded PRNG (mulberry32) - the ONLY randomness source
 * anywhere in this module; Math.random() must never appear in engine.ts or
 * anything it calls. A small, fast, well-known generator with good enough
 * statistical quality for bootstrap resampling / win-loss coin flips
 * (this is a trading-analytics visualization tool, not a cryptographic or
 * scientific-simulation context that would need a stronger generator).
 *
 * Same seed always produces the same sequence of draws - the spec's own
 * determinism requirement ("same inputs + seed = identical results",
 * "changing the seed produces a different simulation") - verified directly
 * in rng.test.ts.
 */
export function createRng(seed: number): Rng {
  // >>> 0 folds any input (including negative numbers or a seed typed as a
  // float) into a 32-bit unsigned integer state, so any finite `seed` value
  // the UI can produce is a valid input.
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** For the UI's "Randomize Seed" convenience button only - never used
 * inside the engine itself (see this file's own doc comment). A 32-bit
 * unsigned int, matching what createRng consumes. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
