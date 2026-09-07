import type { PeriodStats } from "../../strategy/analysis/dateAnalytics";
import "./panels.css";
import "./DetailedAnalysis.css";

interface YearlyPerformanceTableProps {
  yearlyMap: Map<number, PeriodStats>;
}

/** Thin panel-table wrapper - reuses the same table/pos/neg styling
 * TradesPanel/StatsPanel already use, rather than inventing new table CSS. */
export function YearlyPerformanceTable({ yearlyMap }: YearlyPerformanceTableProps) {
  const years = [...yearlyMap.keys()].sort((a, b) => b - a);

  return (
    <div className="da-card">
      <span className="da-widget-title">Yearly Performance</span>
      <table className="panel-table">
        <thead>
          <tr>
            <th>Year</th>
            <th>Total Trades</th>
            <th>Total RR</th>
            <th>Win Rate</th>
            <th>Avg. RR</th>
          </tr>
        </thead>
        <tbody>
          {years.map((year) => {
            const s = yearlyMap.get(year)!;
            return (
              <tr key={year}>
                <td className="mono">{year}</td>
                <td className="mono">{s.count}</td>
                <td className={`mono ${s.totalRR >= 0 ? "pos" : "neg"}`}>
                  {s.totalRR >= 0 ? "+" : ""}
                  {s.totalRR.toFixed(2)}R
                </td>
                <td className="mono">{s.winRate.toFixed(1)}%</td>
                <td className={`mono ${s.avgRR >= 0 ? "pos" : "neg"}`}>
                  {s.avgRR >= 0 ? "+" : ""}
                  {s.avgRR.toFixed(2)}R
                </td>
              </tr>
            );
          })}
          {years.length === 0 && (
            <tr>
              <td colSpan={5} className="panel-empty">
                No trades
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
