import { useEffect, useRef } from "react";
import { createChart, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useTheme } from "../../theme/ThemeProvider";
import { chartOptions, paletteColor } from "../chartTheme";
import { equityEnvelope } from "../../strategy/monteCarlo/statistics";
import type { MonteCarloRawResult } from "../../strategy/monteCarlo/types";
import "./MonteCarlo.css";

interface MonteCarloEquityChartProps {
  result: MonteCarloRawResult;
}

/**
 * Monte Carlo Equity Curve - a standalone lightweight-charts instance (same
 * library/theming helper as CumulativeRRChart.tsx), but its x-axis is a
 * TRADE INDEX (0..tradesPerSimulation-1), not a real calendar timestamp -
 * unlike every other chart in this app. lightweight-charts only requires
 * strictly increasing numeric "time" values, so integers work fine here;
 * this chart's own instance never mixes with a real-time chart's domain.
 *
 * Renders result.representativePaths (already capped at ~50-100 by
 * engine.ts - never "thousands", per spec) as faint individual lines,
 * plus the 5th/median/95th percentile envelope (computed across ALL
 * simulations, via statistics.ts's equityEnvelope) as three prominent
 * lines on top.
 */
export function MonteCarloEquityChart({ result }: MonteCarloEquityChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const pathSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const envelopeSeriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...chartOptions(theme),
      width: containerRef.current.clientWidth,
      height: 280,
      // This chart's "time" axis is really a 0-based TRADE INDEX (see this
      // file's module doc comment), not a calendar date - without a custom
      // formatter, lightweight-charts renders raw small integers as
      // seconds-since-epoch dates ("1970"), which is meaningless here.
      localization: { timeFormatter: (time: UTCTimestamp) => `Trade ${time}` },
      timeScale: {
        ...chartOptions(theme).timeScale,
        timeVisible: false,
        secondsVisible: false,
        tickMarkFormatter: (time: UTCTimestamp) => String(time),
      },
    });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 280);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      pathSeriesRef.current = [];
      envelopeSeriesRef.current = [];
    };
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const s of pathSeriesRef.current) chart.removeSeries(s);
    for (const s of envelopeSeriesRef.current) chart.removeSeries(s);
    pathSeriesRef.current = [];
    envelopeSeriesRef.current = [];

    // Low-opacity neutral stroke for the many individual paths - a fixed,
    // small, presentational constant local to this chart (chartTheme.ts's
    // PALETTE only exposes bull/bear/highlight, not a generic faint tone).
    const faintPath = theme === "dark" ? "rgba(230, 233, 239, 0.14)" : "rgba(18, 20, 27, 0.14)";

    for (const path of result.representativePaths) {
      const series = chart.addSeries(LineSeries, {
        color: faintPath,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(path.map((value, i) => ({ time: i as UTCTimestamp, value })));
      pathSeriesRef.current.push(series);
    }

    const envelope = equityEnvelope(result);
    const p5Series = chart.addSeries(LineSeries, {
      color: paletteColor(theme, "bear"),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "5th pct",
    });
    p5Series.setData(envelope.map((p) => ({ time: p.tradeIndex as UTCTimestamp, value: p.p5 })));

    const p95Series = chart.addSeries(LineSeries, {
      color: paletteColor(theme, "bull"),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "95th pct",
    });
    p95Series.setData(envelope.map((p) => ({ time: p.tradeIndex as UTCTimestamp, value: p.p95 })));

    const medianSeries = chart.addSeries(LineSeries, {
      color: paletteColor(theme, "highlight"),
      lineWidth: 2,
      priceLineVisible: false,
      title: "Median",
    });
    medianSeries.setData(envelope.map((p) => ({ time: p.tradeIndex as UTCTimestamp, value: p.median })));

    envelopeSeriesRef.current = [p5Series, p95Series, medianSeries];
    chart.timeScale().fitContent();
  }, [result, theme]);

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Monte Carlo Equity Curves</span>
        <span className="panel-dim mc-legend">
          <span className="mc-legend-swatch mc-legend-bull" /> 95th pct
          <span className="mc-legend-swatch mc-legend-highlight" /> Median
          <span className="mc-legend-swatch mc-legend-bear" /> 5th pct
        </span>
      </div>
      <div ref={containerRef} className="da-chart-container" />
    </div>
  );
}
