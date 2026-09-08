import type { CandidateMetrics, OverfitWarning, StabilityResult, SymbolRobustnessResult, TimeRobustnessResult } from "./types";

/**
 * Overfitting warning generation - pure, deterministic, text-only. Every
 * threshold below is fixed and documented (not user-tunable), matching
 * this project's existing interpretation.ts/challengeInterpretation.ts
 * convention of small, explainable rule sets producing human-readable
 * lines rather than a black-box score. These are SIGNALS, not gates - per
 * spec, a high-severity warning is displayed prominently but never used to
 * silently exclude a candidate from the ranking table.
 */
export interface OverfitWarningInput {
  evDegradationPct: number | null;
  totalRDegradationPct: number | null;
  stability: StabilityResult;
  symbolRobustness: SymbolRobustnessResult;
  timeRobustness: TimeRobustnessResult;
  testMetrics: CandidateMetrics;
}

export function generateOverfitWarnings(input: OverfitWarningInput): OverfitWarning[] {
  const { evDegradationPct, totalRDegradationPct, stability, symbolRobustness, timeRobustness, testMetrics } = input;
  const warnings: OverfitWarning[] = [];

  // Train -> Test degradation. A sign flip (positive Train EV, negative
  // Test EV) is automatically captured here too: computeDegradationPct's
  // abs(trainValue) denominator (trainTestSplit.ts) turns e.g. train=+2R,
  // test=-1R into -150%, which already crosses the HIGH threshold below -
  // no separate sign-flip check is needed.
  const degradations = [evDegradationPct, totalRDegradationPct].filter((d): d is number => d !== null);
  if (degradations.length > 0) {
    const worst = Math.min(...degradations);
    if (worst <= -80) {
      warnings.push({
        severity: "high",
        message: `Performance degraded ${Math.abs(worst).toFixed(0)}% from Train to Test - a strong sign the historical result did not persist out-of-sample.`,
      });
    } else if (worst <= -40) {
      warnings.push({
        severity: "medium",
        message: `Performance degraded ${Math.abs(worst).toFixed(0)}% from Train to Test - treat the Train-period result with caution.`,
      });
    } else if (worst < 0) {
      warnings.push({
        severity: "low",
        message: `Performance degraded ${Math.abs(worst).toFixed(0)}% from Train to Test - a mild, within-normal-range amount of out-of-sample variation.`,
      });
    }
  }

  if (stability.isIsolatedPeak) {
    warnings.push({
      severity: "medium",
      message:
        "This parameter combination is an isolated performance spike - its immediate neighbors underperform significantly, a common signature of overfitting to historical noise rather than a real, stable edge.",
    });
  }

  if (symbolRobustness.bySymbol.length > 1) {
    if (symbolRobustness.profitableSymbolsPct < 40) {
      warnings.push({
        severity: "high",
        message: `Only ${symbolRobustness.profitableSymbolsPct.toFixed(0)}% of tested symbols were profitable - this edge does not appear to generalize across instruments.`,
      });
    } else if (symbolRobustness.profitableSymbolsPct < 60) {
      warnings.push({
        severity: "medium",
        message: `${symbolRobustness.profitableSymbolsPct.toFixed(0)}% of tested symbols were profitable - cross-symbol consistency is mixed.`,
      });
    }
  }

  if (timeRobustness.concentratedInOneYear) {
    warnings.push({
      severity: "medium",
      message: "A single year accounts for most of this strategy's total R - performance is concentrated rather than consistent across time.",
    });
  }

  if (testMetrics.insufficientSample) {
    warnings.push({
      severity: "low",
      message: `Only ${testMetrics.trades} trade(s) in the Test period - below the minimum sample size, so Test-period conclusions are not statistically reliable.`,
    });
  }

  return warnings;
}
