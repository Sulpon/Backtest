import type { ChallengeRiskComparisonRow } from "../../strategy/monteCarlo/challengeRiskComparison";
import "./panels.css";
import "./DetailedAnalysis.css";

function money(n: number | null): string {
  return n == null ? "N/A" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface ChallengeRiskComparisonTableProps {
  rows: ChallengeRiskComparisonRow[];
  /** The risk level the primary result was actually run at - highlighted
   * as its own row, per spec ("Highlight the selected risk level"). */
  selectedRiskPct: number;
}

/**
 * The Challenge Simulator's own Risk Comparison table - reuses the
 * panel-table styling verbatim (same as every other table in this app),
 * one row per canonical risk level from challengeRiskComparison.ts (which
 * itself reuses the SAME retained R sequences across every row, never a
 * fresh redundant simulation per row).
 */
export function ChallengeRiskComparisonTable({ rows, selectedRiskPct }: ChallengeRiskComparisonTableProps) {
  return (
    <div className="da-card">
      <span className="da-widget-title">Risk Comparison</span>
      <div style={{ overflowX: "auto" }}>
        <table className="panel-table">
          <thead>
            <tr>
              <th>Risk</th>
              <th>Pass Rate</th>
              <th>Trades / Success</th>
              <th>Expected Attempts</th>
              <th>Expected Trades to Fund</th>
              <th>Expected Cost</th>
              <th>90% Confidence Cost</th>
              <th>5+ Failure Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.riskPct} className={row.riskPct === selectedRiskPct ? "active" : ""}>
                <td className="mono">{row.riskPct.toFixed(2)}%</td>
                <td className="mono">{row.stats.passRate.toFixed(1)}%</td>
                <td className="mono">{row.stats.tradesToSuccess ? row.stats.tradesToSuccess.mean.toFixed(1) : "N/A"}</td>
                <td className="mono">{row.stats.expectedAttempts != null ? row.stats.expectedAttempts.toFixed(2) : "Effectively impossible"}</td>
                <td className="mono">{row.stats.expectedTradesToFund != null ? row.stats.expectedTradesToFund.toFixed(0) : "N/A"}</td>
                <td className="mono">{money(row.stats.expectedCost)}</td>
                <td className="mono">{money(row.stats.confidenceCost90)}</td>
                <td className="mono">{row.stats.failureRisk5Plus.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
