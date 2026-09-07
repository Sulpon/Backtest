import type { ChallengeAggregateStats } from "./challengeStatistics";

/**
 * Dynamic, probabilistic-language sentences for the Challenge Simulator's
 * Interpretation section - every value comes from a real
 * ChallengeAggregateStats, never hardcoded. Mirrors interpretation.ts's
 * exact tone/rules ("Based on...", "the estimated...", never "you will
 * pass" or a guaranteed claim).
 */
function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function challengeInterpretation(sourceLabel: string, numSimulations: number, stats: ChallengeAggregateStats): string[] {
  const lines: string[] = [
    `Based on ${numSimulations.toLocaleString()} simulated challenge attempts (${sourceLabel}), the estimated pass probability under this configuration is ${stats.passRate.toFixed(1)}%.`,
  ];

  if (stats.expectedAttempts == null || stats.expectedCost == null) {
    lines.push("No simulated attempts passed under this configuration - funding is effectively impossible with these settings as simulated.");
  } else {
    lines.push(
      `On average, the simulated outcome distribution suggests approximately ${stats.expectedAttempts.toFixed(2)} attempts (expected cost ${money(stats.expectedCost)}) to reach a funded account.`
    );
    if (stats.confidenceCost90 != null) {
      lines.push(`10% of simulated funding journeys cost more than ${money(stats.confidenceCost90)} (i.e. the 90% confidence cost is ${money(stats.confidenceCost90)}).`);
    }
  }

  lines.push(
    `Under this configuration, the estimated probability of 5 or more CONSECUTIVE FAILED CHALLENGE ATTEMPTS (not losing trades) is ${stats.failureRisk5Plus.toFixed(1)}%.`
  );

  return lines;
}
