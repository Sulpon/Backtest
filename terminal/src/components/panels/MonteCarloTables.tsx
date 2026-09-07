import type { RiskComparisonRow } from "../../strategy/monteCarlo/riskEquity";
import type { StreakStats } from "../../strategy/monteCarlo/statistics";
import "./panels.css";
import "./DetailedAnalysis.css";

function signedPct(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

interface RiskComparisonTableProps {
  rows: RiskComparisonRow[];
}

/** Thin panel-table wrapper, same pattern as YearlyPerformanceTable.tsx -
 * every row comes from riskEquity.ts's riskComparison(), which re-applies
 * each risk level to the SAME retained R sequences (see that function's
 * own doc comment) - this table visualizes position sizing, never a
 * change in the underlying strategy's R expectancy. */
export function RiskComparisonTable({ rows }: RiskComparisonTableProps) {
  return (
    <div className="da-card">
      <span className="da-widget-title">Risk Comparison</span>
      <table className="panel-table">
        <thead>
          <tr>
            <th>Risk / Trade</th>
            <th>Median Return</th>
            <th>95% Max DD</th>
            <th>Prob. Positive</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.riskPct}>
              <td className="mono">{row.riskPct.toFixed(2)}%</td>
              <td className={`mono ${row.medianReturnPct >= 0 ? "pos" : "neg"}`}>{signedPct(row.medianReturnPct)}</td>
              <td className="mono neg">{signedPct(row.p95MaxDrawdownPct)}</td>
              <td className="mono">{row.probabilityPositive.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface StreakAnalysisTableProps {
  winning: StreakStats;
  losing: StreakStats;
}

/** Median/p75/p90/p95/max for both streak directions, side by side - one
 * table rather than two, since every row is the same five percentile
 * points for each direction. */
export function StreakAnalysisTable({ winning, losing }: StreakAnalysisTableProps) {
  const rows: { label: string; win: number; lose: number }[] = [
    { label: "Median", win: winning.median, lose: losing.median },
    { label: "75th percentile", win: winning.p75, lose: losing.p75 },
    { label: "90th percentile", win: winning.p90, lose: losing.p90 },
    { label: "95th percentile", win: winning.p95, lose: losing.p95 },
    { label: "Maximum observed", win: winning.max, lose: losing.max },
  ];
  return (
    <div className="da-card">
      <span className="da-widget-title">Streak Analysis</span>
      <table className="panel-table">
        <thead>
          <tr>
            <th></th>
            <th>Max Winning Streak</th>
            <th>Max Losing Streak</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="panel-dim">{r.label}</td>
              <td className="mono">{r.win.toFixed(1)}</td>
              <td className="mono">{r.lose.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
