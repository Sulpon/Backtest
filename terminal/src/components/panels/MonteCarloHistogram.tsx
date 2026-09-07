import type { HistogramBin } from "../../strategy/monteCarlo/statistics";
import "./MonteCarlo.css";

interface MonteCarloHistogramProps {
  bins: HistogramBin[];
  formatValue?: (v: number) => string;
}

/** Reusable equal-width bar chart for the Final R Distribution and Max
 * Drawdown Distribution charts - plain CSS bars rather than
 * lightweight-charts: a histogram's x-axis is a numeric bin range, not a
 * time series, and lightweight-charts' HistogramSeries is built around a
 * time scale - a hand-rolled bar row is simpler and avoids fighting that
 * assumption for this one non-time chart shape (the actual time-series
 * chart, the Equity Curve, does use lightweight-charts - see
 * MonteCarloEquityChart.tsx). */
export function MonteCarloHistogram({ bins, formatValue = (v) => v.toFixed(1) }: MonteCarloHistogramProps) {
  if (bins.length === 0) return <div className="panel-empty">No data</div>;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div className="mc-histogram">
      {bins.map((b, i) => {
        const mid = (b.from + b.to) / 2;
        const heightPct = (b.count / maxCount) * 100;
        return (
          <div
            key={i}
            className={`mc-hist-bar ${mid >= 0 ? "pos" : "neg"}`}
            style={{ height: `${Math.max(heightPct, b.count > 0 ? 2 : 0)}%` }}
            title={`${formatValue(b.from)} to ${formatValue(b.to)}: ${b.count}`}
          />
        );
      })}
    </div>
  );
}
