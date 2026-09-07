import { useState } from "react";
import type { PeriodStats } from "../../strategy/analysis/dateAnalytics";
import "./DetailedAnalysis.css";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface MonthlyPerformanceWidgetProps {
  /** Keyed by "YYYY-MM" (exitDateParts.monthKey) - see dateAnalytics.ts. */
  monthlyMap: Map<string, PeriodStats>;
  defaultYear: number;
}

function classify(totalRR: number, count: number): "pos" | "neg" | "neutral" {
  if (count === 0 || totalRR === 0) return "neutral";
  return totalRR > 0 ? "pos" : "neg";
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}R`;
}

/** Free navigation (no min/max clamping to available data) - unlike
 * ReplayCalendar.tsx's picker (which must stay within actually-existing bar
 * data), a performance viewer showing "0 trades" for an empty year is a
 * valid, meaningful state, not an error - clamping would add complexity for
 * no real benefit here. */
export function MonthlyPerformanceWidget({ monthlyMap, defaultYear }: MonthlyPerformanceWidgetProps) {
  const [viewYear, setViewYear] = useState(defaultYear);

  const months = MONTH_LABELS.map((label, i) => {
    const key = `${viewYear}-${String(i + 1).padStart(2, "0")}`;
    const stats = monthlyMap.get(key);
    return { label, totalRR: stats?.totalRR ?? 0, count: stats?.count ?? 0 };
  });

  const yearTotalRR = months.reduce((sum, m) => sum + m.totalRR, 0);
  const yearTotalTrades = months.reduce((sum, m) => sum + m.count, 0);

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Monthly Performance</span>
        <div className="da-year-nav">
          <button type="button" className="da-nav-btn" onClick={() => setViewYear((y) => y - 1)} title="Previous year">
            ‹
          </button>
          <span className="mono da-year-label">{viewYear}</span>
          <button type="button" className="da-nav-btn" onClick={() => setViewYear((y) => y + 1)} title="Next year">
            ›
          </button>
        </div>
      </div>
      <div className="da-month-grid">
        {months.map((m) => (
          <div key={m.label} className={`da-cell ${classify(m.totalRR, m.count)}`}>
            <div className="da-cell-label">{m.label}</div>
            <div className="da-cell-rr mono">{m.count === 0 ? "0.0R" : signed(m.totalRR)}</div>
            <div className="da-cell-count">
              {m.count} {m.count === 1 ? "trade" : "trades"}
            </div>
          </div>
        ))}
      </div>
      <div className="da-period-total mono">
        <span className="panel-dim">Year Total</span>
        <span className={yearTotalRR > 0 ? "da-pos" : yearTotalRR < 0 ? "da-neg" : ""}>{signed(yearTotalRR)}</span>
        <span className="panel-dim">{yearTotalTrades} trades</span>
      </div>
    </div>
  );
}
