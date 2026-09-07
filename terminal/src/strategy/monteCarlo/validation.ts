/**
 * Strategy Lab input validation - the spec's own explicit rule list ("0 <
 * Win Rate < 100", "Average Win > 0", ... "Do not allow NaN/Infinity/
 * negative RR/invalid probabilities"). Pure function, reused by the
 * Strategy Lab form (disables "Run Simulation" and shows the returned
 * messages) so there's exactly one place these rules live.
 */
export interface LabParamsInput {
  winRatePct: number;
  avgWinR: number;
  avgLossR: number;
  riskPct: number;
  tradesPerSimulation: number;
  numSimulations: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function finiteOrError(value: number, label: string, errors: string[]): boolean {
  if (!Number.isFinite(value)) {
    errors.push(`${label} must be a finite number.`);
    return false;
  }
  return true;
}

export function validateLabParams(params: LabParamsInput): ValidationResult {
  const errors: string[] = [];

  if (finiteOrError(params.winRatePct, "Win Rate", errors) && (params.winRatePct <= 0 || params.winRatePct >= 100)) {
    errors.push("Win Rate must be between 0 and 100 (exclusive).");
  }
  if (finiteOrError(params.avgWinR, "Average Win", errors) && params.avgWinR <= 0) {
    errors.push("Average Win must be greater than 0.");
  }
  if (finiteOrError(params.avgLossR, "Average Loss", errors) && params.avgLossR <= 0) {
    errors.push("Average Loss must be greater than 0.");
  }
  if (finiteOrError(params.riskPct, "Risk per Trade", errors) && params.riskPct < 0) {
    errors.push("Risk per Trade must be 0 or greater.");
  }
  if (finiteOrError(params.tradesPerSimulation, "Trades per Simulation", errors) && params.tradesPerSimulation <= 0) {
    errors.push("Trades per Simulation must be greater than 0.");
  }
  if (finiteOrError(params.numSimulations, "Number of Simulations", errors) && params.numSimulations <= 0) {
    errors.push("Number of Simulations must be greater than 0.");
  }

  return { valid: errors.length === 0, errors };
}

/** Custom Distribution's own extra rule: every outcome needs a finite,
 * positive probability weight, and wins must be positive-R / losses
 * negative-R (see types.ts's CustomDistributionParams doc comment). */
export function validateCustomOutcomes(
  wins: { r: number; probabilityPct: number }[],
  losses: { r: number; probabilityPct: number }[]
): ValidationResult {
  const errors: string[] = [];
  if (wins.length === 0) errors.push("Add at least one winning outcome.");
  if (losses.length === 0) errors.push("Add at least one losing outcome.");
  for (const w of wins) {
    if (!Number.isFinite(w.r) || w.r <= 0) errors.push("Every winning outcome's R must be greater than 0.");
    if (!Number.isFinite(w.probabilityPct) || w.probabilityPct <= 0) errors.push("Every winning outcome needs a positive probability.");
  }
  for (const l of losses) {
    if (!Number.isFinite(l.r) || l.r >= 0) errors.push("Every losing outcome's R must be less than 0.");
    if (!Number.isFinite(l.probabilityPct) || l.probabilityPct <= 0) errors.push("Every losing outcome needs a positive probability.");
  }
  return { valid: errors.length === 0, errors };
}
