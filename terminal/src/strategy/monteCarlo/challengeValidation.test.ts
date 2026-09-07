import { describe, expect, it } from "vitest";
import { validateChallengeConfig, type ChallengeConfigInput } from "./challengeValidation";

function valid(): ChallengeConfigInput {
  return {
    accountSize: 100000,
    challengeType: "single",
    phase1TargetPct: 8,
    phase1MaxDDPct: 10,
    phase2TargetPct: null,
    phase2MaxDDPct: null,
    dailyDrawdownEnabled: false,
    dailyDrawdownPct: null,
    riskPct: 1,
    profitSplitPct: 80,
    challengeFee: 500,
    numSimulations: 10000,
    tradesPerSimulation: 100,
  };
}

describe("validateChallengeConfig", () => {
  it("accepts a valid single-phase config", () => {
    expect(validateChallengeConfig(valid()).valid).toBe(true);
  });

  it("rejects non-positive account size / target / drawdown", () => {
    expect(validateChallengeConfig({ ...valid(), accountSize: 0 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), phase1TargetPct: -1 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), phase1MaxDDPct: 0 }).valid).toBe(false);
  });

  it("requires phase 2 target/DD for a two-phase challenge", () => {
    const input = { ...valid(), challengeType: "two-phase" as const, phase2TargetPct: null, phase2MaxDDPct: null };
    expect(validateChallengeConfig(input).valid).toBe(false);
  });

  it("accepts a valid two-phase config", () => {
    const input = { ...valid(), challengeType: "two-phase" as const, phase2TargetPct: 5, phase2MaxDDPct: 10 };
    expect(validateChallengeConfig(input).valid).toBe(true);
  });

  it("requires a daily drawdown value when enabled", () => {
    expect(validateChallengeConfig({ ...valid(), dailyDrawdownEnabled: true, dailyDrawdownPct: null }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), dailyDrawdownEnabled: true, dailyDrawdownPct: 5 }).valid).toBe(true);
  });

  it("rejects risk <= 0 or >= 100", () => {
    expect(validateChallengeConfig({ ...valid(), riskPct: 0 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), riskPct: 100 }).valid).toBe(false);
  });

  it("rejects profit split outside 0-100", () => {
    expect(validateChallengeConfig({ ...valid(), profitSplitPct: -1 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), profitSplitPct: 101 }).valid).toBe(false);
  });

  it("rejects negative fee, accepts zero fee", () => {
    expect(validateChallengeConfig({ ...valid(), challengeFee: -1 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), challengeFee: 0 }).valid).toBe(true);
  });

  it("rejects non-positive simulation/trade counts", () => {
    expect(validateChallengeConfig({ ...valid(), numSimulations: 0 }).valid).toBe(false);
    expect(validateChallengeConfig({ ...valid(), tradesPerSimulation: 0 }).valid).toBe(false);
  });
});
