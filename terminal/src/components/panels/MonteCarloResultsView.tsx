import { useMemo } from "react";
import type { ModeRunState } from "../../strategy/monteCarlo/monteCarloStore";
import { aggregateResults, histogramBins } from "../../strategy/monteCarlo/statistics";
import { riskComparison } from "../../strategy/monteCarlo/riskEquity";
import { MonteCarloEquityChart } from "./MonteCarloEquityChart";
import { MonteCarloHistogram } from "./MonteCarloHistogram";
import { RiskComparisonTable, StreakAnalysisTable } from "./MonteCarloTables";
import "./panels.css";
import "./DetailedAnalysis.css";
import "./MonteCarlo.css";

function signedR(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}R`;
}

interface MonteCarloResultsViewProps {
  run: ModeRunState;
  /** Dynamically generated, probabilistic-language sentences (never
   * "your strategy will make X") - built by the mode-specific parent
   * (MonteCarloMyStrategyMode/MonteCarloStrategyLabMode), since only it
   * knows the historical trade count / lab parameters that belong in the
   * wording. This component only renders them. */
  interpretationLines: string[];
  /** Shown disabled/idle-friendly copy while there's no result yet, e.g.
   * "Configure My Strategy's filters and settings, then press Run Monte
   * Carlo." - lets the two modes use slightly different call-to-action
   * text for the same idle state. */
  idleHint: string;
}

/**
 * Shared results block for BOTH Monte Carlo modes - per spec, "Results and
 * charts are identical in structure" between My Strategy and Strategy Lab.
 * Purely a renderer over a ModeRunState + derived statistics; never reads
 * strategyScanStore or builds a SimulationRunConfig itself (that's each
 * mode's own component, since only they know their own filters/params).
 */
export function MonteCarloResultsView({ run, interpretationLines, idleHint }: MonteCarloResultsViewProps) {
  const result = run.result;

  const agg = useMemo(() => (result ? aggregateResults(result) : null), [result]);
  const finalRBins = useMemo(() => (result ? histogramBins(result.finalR, 24) : []), [result]);
  const ddBins = useMemo(() => (result ? histogramBins(result.maxDrawdownR, 24) : []), [result]);
  const riskRows = useMemo(() => (result ? riskComparison(result.retainedRSequences) : []), [result]);

  if (run.status === "idle" && !result) {
    return <div className="panel-empty mc-idle">{idleHint}</div>;
  }

  if (run.status === "running") {
    const pct = run.progress ? Math.round((run.progress.completed / run.progress.total) * 100) : 0;
    return (
      <div className="mc-progress">
        <div className="panel-dim">
          Running Monte Carlo... {run.progress ? `${run.progress.completed.toLocaleString()} / ${run.progress.total.toLocaleString()}` : ""}{" "}
          simulations
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

  if (!result || !agg) {
    return <div className="panel-empty mc-idle">{idleHint}</div>;
  }

  return (
    <div className="mc-results">
      <div className="panel-dim mc-source-label">{run.sourceLabel}</div>

      <div className="panel-summary mono">
        <div>
          <span className="panel-dim">Median Final R</span>
          <span className={agg.finalR.median >= 0 ? "pos" : "neg"}>{signedR(agg.finalR.median)}</span>
        </div>
        <div>
          <span className="panel-dim">Mean Final R</span>
          <span className={agg.finalR.mean >= 0 ? "pos" : "neg"}>{signedR(agg.finalR.mean)}</span>
        </div>
        <div>
          <span className="panel-dim">5th Percentile</span>
          <span className={agg.finalR.p5 >= 0 ? "pos" : "neg"}>{signedR(agg.finalR.p5)}</span>
        </div>
        <div>
          <span className="panel-dim">95th Percentile</span>
          <span className={agg.finalR.p95 >= 0 ? "pos" : "neg"}>{signedR(agg.finalR.p95)}</span>
        </div>
        <div>
          <span className="panel-dim">Probability Positive</span>
          <span>{agg.finalR.probabilityPositive.toFixed(1)}%</span>
        </div>
        <div>
          <span className="panel-dim">Median Max DD</span>
          <span className="neg">{signedR(agg.maxDrawdown.median)}</span>
        </div>
        <div>
          <span className="panel-dim">95% Max DD</span>
          <span className="neg">{signedR(agg.maxDrawdown.p95)}</span>
        </div>
        <div>
          <span className="panel-dim">Max Losing Streak</span>
          <span>{agg.losingStreak.max.toFixed(0)} trades</span>
        </div>
      </div>

      <MonteCarloEquityChart result={result} />

      <div className="da-card">
        <span className="da-widget-title">Final R Distribution</span>
        <MonteCarloHistogram bins={finalRBins} formatValue={(v) => signedR(v, 1)} />
        <div className="da-period-total mono mc-dist-summary">
          <span className="panel-dim">Median {signedR(agg.finalR.median)}</span>
          <span className="panel-dim">5th {signedR(agg.finalR.p5)}</span>
          <span className="panel-dim">95th {signedR(agg.finalR.p95)}</span>
          <span className="panel-dim">Positive {agg.finalR.probabilityPositive.toFixed(1)}%</span>
        </div>
      </div>

      <div className="da-card">
        <span className="da-widget-title">Max Drawdown Distribution</span>
        <MonteCarloHistogram bins={ddBins} formatValue={(v) => signedR(v, 1)} />
        <div className="da-period-total mono mc-dist-summary">
          <span className="panel-dim">Median {signedR(agg.maxDrawdown.median)}</span>
          <span className="panel-dim">75th {signedR(agg.maxDrawdown.p75)}</span>
          <span className="panel-dim">90th {signedR(agg.maxDrawdown.p90)}</span>
          <span className="panel-dim">95th {signedR(agg.maxDrawdown.p95)}</span>
          <span className="panel-dim">Worst {signedR(agg.maxDrawdown.worst)}</span>
        </div>
      </div>

      <StreakAnalysisTable winning={agg.winningStreak} losing={agg.losingStreak} />
      <RiskComparisonTable rows={riskRows} />

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
