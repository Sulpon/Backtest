import { useMemo } from "react";
import type { ChallengeModeRunState } from "../../strategy/monteCarlo/monteCarloStore";
import { createRng } from "../../strategy/monteCarlo/rng";
import { aggregateChallengeStats, breakEvenAnalysis } from "../../strategy/monteCarlo/challengeStatistics";
import { challengeRiskComparison } from "../../strategy/monteCarlo/challengeRiskComparison";
import { challengeInterpretation } from "../../strategy/monteCarlo/challengeInterpretation";
import { ChallengePathsChart } from "./ChallengePathsChart";
import { ChallengeRiskComparisonTable } from "./ChallengeRiskComparisonTable";
import { RiskLineChart } from "./RiskLineChart";
import "./panels.css";
import "./DetailedAnalysis.css";
import "./MonteCarlo.css";

function money(n: number | null): string {
  return n == null ? "Effectively impossible" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface ChallengeResultsViewProps {
  run: ChallengeModeRunState;
  tradesPerPhaseCap: number;
  tradesPerDay: number | null;
  fee: number;
  profitSplitPct: number;
  seed: number;
  idleHint: string;
}

/**
 * The Challenge Simulator's primary results block - KPI row, both "vs
 * Risk" charts, the Challenge Equity Paths chart, the Risk Comparison
 * table, Break-Even Analysis, and the dynamic Interpretation section. A
 * pure renderer over a ChallengeModeRunState; never builds a
 * ChallengeRunConfig or touches strategyScanStore itself (that's
 * MonteCarloChallengeMode.tsx's job).
 */
export function ChallengeResultsView({ run, tradesPerPhaseCap, tradesPerDay, fee, profitSplitPct, seed, idleHint }: ChallengeResultsViewProps) {
  const result = run.result;

  const stats = useMemo(() => {
    if (!result) return null;
    return aggregateChallengeStats(result.outcomes, result.tradesUsed, fee, createRng(seed + 500));
  }, [result, fee, seed]);

  const riskRows = useMemo(() => {
    if (!result) return [];
    return challengeRiskComparison(result.retainedRSequences, result.challenge, result.accountSize, tradesPerPhaseCap, tradesPerDay, fee, seed);
  }, [result, tradesPerPhaseCap, tradesPerDay, fee, seed]);

  const breakEven = useMemo(() => {
    if (!stats || !result) return null;
    return breakEvenAnalysis(stats.expectedCost, result.accountSize, profitSplitPct);
  }, [stats, result, profitSplitPct]);

  const interpretationLines = useMemo(() => {
    if (!stats || !result) return [];
    return challengeInterpretation(run.sourceLabel, result.numSimulations, stats);
  }, [stats, result, run.sourceLabel]);

  if (run.status === "idle" && !result) {
    return <div className="panel-empty mc-idle">{idleHint}</div>;
  }

  if (run.status === "running") {
    const pct = run.progress ? Math.round((run.progress.completed / run.progress.total) * 100) : 0;
    return (
      <div className="mc-progress">
        <div className="panel-dim">
          Running Challenge Simulation...{" "}
          {run.progress ? `${run.progress.completed.toLocaleString()} / ${run.progress.total.toLocaleString()}` : ""} simulations
        </div>
        <div className="mc-progress-bar">
          <div className="mc-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (run.status === "error") {
    return <div className="panel-empty mc-error">Simulation failed: {run.error}</div>;
  }

  if (!result || !stats || !breakEven) {
    return <div className="panel-empty mc-idle">{idleHint}</div>;
  }

  const passRatePoints = riskRows.map((r) => ({ riskPct: r.riskPct, value: r.stats.passRate }));
  const costPoints = riskRows.map((r) => ({ riskPct: r.riskPct, value: r.stats.expectedCost ?? 0 }));

  return (
    <div className="mc-results">
      <div className="panel-dim mc-source-label">{run.sourceLabel}</div>

      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Pass Rate</span>
          <span className="pos">{stats.passRate.toFixed(1)}%</span>
        </div>
        <div>
          <span className="panel-dim">Fail Rate</span>
          <span className="neg">{stats.failRate.toFixed(1)}%</span>
        </div>
        <div>
          <span className="panel-dim">Trades / Success</span>
          <span>{stats.tradesToSuccess ? stats.tradesToSuccess.mean.toFixed(0) : "N/A"}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Attempts</span>
          <span>{stats.expectedAttempts != null ? stats.expectedAttempts.toFixed(2) : "Effectively impossible"}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Trades to Fund</span>
          <span>{stats.expectedTradesToFund != null ? stats.expectedTradesToFund.toFixed(0) : "N/A"}</span>
        </div>
        <div>
          <span className="panel-dim">Expected Cost</span>
          <span>{money(stats.expectedCost)}</span>
        </div>
        <div>
          <span className="panel-dim">90% Confidence Cost</span>
          <span>{money(stats.confidenceCost90)}</span>
        </div>
        <div>
          <span className="panel-dim">5+ Failure Risk</span>
          <span title="Probability of 5 or more CONSECUTIVE FAILED CHALLENGE ATTEMPTS - not losing trades.">{stats.failureRisk5Plus.toFixed(1)}%</span>
        </div>
      </div>

      <RiskLineChart title="Pass Rate vs Risk" points={passRatePoints} formatValue={(v) => `${v.toFixed(1)}%`} />
      <RiskLineChart title="Expected Cost to Fund vs Risk" points={costPoints} formatValue={(v) => money(v)} />

      <ChallengeRiskComparisonTable rows={riskRows} selectedRiskPct={result.riskPct} />

      <ChallengePathsChart result={result} />

      <div className="da-card">
        <span className="da-widget-title">Break-Even Analysis</span>
        <div className="panel-summary mono">
          <div>
            <span className="panel-dim">Expected Cost</span>
            <span>{money(breakEven.expectedCost)}</span>
          </div>
          <div>
            <span className="panel-dim">Break-Even Funded Profit</span>
            <span>{breakEven.breakEvenFundedProfitPct != null ? `${breakEven.breakEvenFundedProfitPct.toFixed(2)}%` : "N/A"}</span>
          </div>
        </div>
        <p className="panel-dim mc-interpretation-line">{breakEven.assumptionNote}</p>
      </div>

      <div className="da-card mc-interpretation">
        <span className="da-widget-title">Interpretation</span>
        {interpretationLines.map((line, i) => (
          <p key={i} className="panel-dim mc-interpretation-line">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
