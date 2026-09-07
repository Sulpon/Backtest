import type { ValidationResult } from "./validation";

/**
 * Challenge Simulator input validation - the spec's own explicit rule
 * list. Reuses validation.ts's ValidationResult shape (not a second
 * validation-result type) so the Strategy Lab and Challenge forms render
 * errors identically.
 */
export interface ChallengeConfigInput {
  accountSize: number;
  challengeType: "single" | "two-phase";
  phase1TargetPct: number;
  phase1MaxDDPct: number;
  phase2TargetPct: number | null;
  phase2MaxDDPct: number | null;
  dailyDrawdownEnabled: boolean;
  dailyDrawdownPct: number | null;
  riskPct: number;
  profitSplitPct: number;
  challengeFee: number;
  numSimulations: number;
  tradesPerSimulation: number;
}

function positive(value: number, label: string, errors: string[]): void {
  if (!Number.isFinite(value) || value <= 0) errors.push(`${label} must be greater than 0.`);
}

export function validateChallengeConfig(input: ChallengeConfigInput): ValidationResult {
  const errors: string[] = [];

  positive(input.accountSize, "Account Size", errors);
  positive(input.phase1TargetPct, "Profit Target", errors);
  positive(input.phase1MaxDDPct, "Maximum Drawdown", errors);

  if (input.challengeType === "two-phase") {
    if (input.phase2TargetPct == null) errors.push("Phase 2 Profit Target is required for a Two Phase challenge.");
    else positive(input.phase2TargetPct, "Phase 2 Profit Target", errors);
    if (input.phase2MaxDDPct == null) errors.push("Phase 2 Maximum Drawdown is required for a Two Phase challenge.");
    else positive(input.phase2MaxDDPct, "Phase 2 Maximum Drawdown", errors);
  }

  if (input.dailyDrawdownEnabled) {
    if (input.dailyDrawdownPct == null) errors.push("Daily Drawdown must be set when enabled.");
    else positive(input.dailyDrawdownPct, "Daily Drawdown", errors);
  }

  if (!Number.isFinite(input.riskPct) || input.riskPct <= 0) errors.push("Risk per Trade must be greater than 0.");
  else if (input.riskPct >= 100) errors.push("Risk per Trade must be below 100%.");

  if (!Number.isFinite(input.profitSplitPct) || input.profitSplitPct < 0 || input.profitSplitPct > 100) {
    errors.push("Profit Split must be between 0 and 100.");
  }
  if (!Number.isFinite(input.challengeFee) || input.challengeFee < 0) errors.push("Challenge Fee must be 0 or greater.");

  positive(input.numSimulations, "Number of Simulations", errors);
  positive(input.tradesPerSimulation, "Trades per Simulation", errors);

  return { valid: errors.length === 0, errors };
}
