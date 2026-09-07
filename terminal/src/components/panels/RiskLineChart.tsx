import { useEffect, useRef } from "react";
import { createChart, LineSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useTheme } from "../../theme/ThemeProvider";
import { chartOptions, paletteColor } from "../chartTheme";
import "./MonteCarlo.css";

export interface RiskLinePoint {
  riskPct: number;
  value: number;
}

interface RiskLineChartProps {
  title: string;
  points: RiskLinePoint[];
  /** Formats a Y value for the crosshair/tooltip line (e.g. "74.2%" or
   * "$1,250"). */
  formatValue: (v: number) => string;
}

/**
 * Reusable small line chart for "<Metric> vs Risk" - used by both Pass
 * Rate vs Risk and Expected Cost vs Risk (never two separate chart
 * implementations for what's structurally the same 7-point plot). Same
 * "index axis with a custom tick formatter" trick MonteCarloEquityChart.
 * tsx already uses for its trade-index axis: lightweight-charts' "time"
 * values here are just 0..6 (one per risk level in riskEquity.ts's
 * RISK_LEVELS_PCT), labeled with the actual risk % via
 * tickMarkFormatter/localization rather than being misread as calendar
 * dates.
 */
export function RiskLineChart({ title, points, formatValue }: RiskLineChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...chartOptions(theme),
      width: containerRef.current.clientWidth,
      height: 220,
      localization: { timeFormatter: (time: UTCTimestamp) => `${points[time as number]?.riskPct ?? time}% risk` },
      timeScale: {
        ...chartOptions(theme).timeScale,
        timeVisible: false,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => `${points[time as number]?.riskPct ?? time}%`,
      },
    });
    const series = chart.addSeries(LineSeries, {
      color: paletteColor(theme, "highlight"),
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 220);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(points.map((p, i) => ({ time: i as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div className="da-card">
      <span className="da-widget-title">{title}</span>
      <div ref={containerRef} className="da-chart-container mc-risk-chart" />
      <div className="da-period-total mc-dist-summary mono panel-dim">
        {points.map((p) => (
          <span key={p.riskPct}>
            {p.riskPct}%: {formatValue(p.value)}
          </span>
        ))}
      </div>
    </div>
  );
}
