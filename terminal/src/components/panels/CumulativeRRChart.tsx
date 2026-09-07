import { useEffect, useRef, useState } from "react";
import { createChart, BaselineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useTheme } from "../../theme/ThemeProvider";
import { chartOptions, paletteColor } from "../chartTheme";
import type { CumulativePoint } from "../../strategy/analysis/dateAnalytics";
import "./DetailedAnalysis.css";

type RangeKey = "all" | "1y" | "6m" | "3m" | "1m";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "1y", label: "1Y" },
  { key: "6m", label: "6M" },
  { key: "3m", label: "3M" },
  { key: "1m", label: "1M" },
];

const RANGE_SECONDS: Record<Exclude<RangeKey, "all">, number> = {
  "1y": 365 * 86400,
  "6m": 182 * 86400,
  "3m": 91 * 86400,
  "1m": 30 * 86400,
};

interface CumulativeRRChartProps {
  series: CumulativePoint[];
}

/**
 * Own standalone lightweight-charts instance (same library ChartPane.tsx
 * uses for the main candlestick chart, via the same chartTheme.ts theming
 * helpers) - a BaselineSeries pinned at 0, matching the exact series type
 * ChartPane.tsx already uses for SL/TP and FVG zones, since it natively
 * colors fill/line differently above vs. below the baseline - a direct fit
 * for "in profit vs. in drawdown" on a cumulative R curve.
 *
 * Range buttons ZOOM the already-built curve (chart.timeScale().
 * setVisibleRange()) - they never re-slice `series` and recompute a fresh
 * running sum starting from 0 at the window boundary. A cumulative total's
 * whole point is that it's continuous: "1M" means "show me the last month
 * of the curve, including what level it was already at going in," not "what
 * would the last month's trades alone have summed to."
 *
 * The chart container renders unconditionally (never swapped out for an
 * empty-state div) - the create-chart effect below only depends on
 * `theme`, so if it ran once against a still-empty container (no trades
 * yet) and the container were later removed/re-added when data appears,
 * the chart would never get (re)created without an unrelated theme change.
 */
export function CumulativeRRChart({ series }: CumulativeRRChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const [range, setRange] = useState<RangeKey>("all");

  useEffect(() => {
    if (!containerRef.current) return;
    const bull = paletteColor(theme, "bull");
    const bear = paletteColor(theme, "bear");
    const chart = createChart(containerRef.current, {
      ...chartOptions(theme),
      width: containerRef.current.clientWidth,
      height: 260,
    });
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topFillColor1: `${bull}40`,
      topFillColor2: `${bull}08`,
      bottomFillColor1: `${bear}08`,
      bottomFillColor2: `${bear}40`,
      topLineColor: bull,
      bottomLineColor: bear,
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 260);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(series.map((p) => ({ time: p.time as UTCTimestamp, value: p.cumulative })));
    chartRef.current?.timeScale().fitContent();
  }, [series]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || series.length === 0) return;
    if (range === "all") {
      chart.timeScale().fitContent();
      return;
    }
    const lastTime = series[series.length - 1].time;
    const from = lastTime - RANGE_SECONDS[range];
    chart.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: lastTime as UTCTimestamp });
  }, [range, series]);

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Cumulative RR</span>
        <div className="da-range-buttons">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`da-range-btn${range === r.key ? " active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="da-chart-wrap">
        {series.length === 0 && <div className="panel-empty da-chart-empty-overlay">No trades in range</div>}
        <div ref={containerRef} className="da-chart-container" />
      </div>
    </div>
  );
}
