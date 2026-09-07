import { useEffect, useRef } from "react";
import { createChart, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useTheme } from "../../theme/ThemeProvider";
import { chartOptions, paletteColor } from "../chartTheme";
import type { ChallengeRawResult } from "../../strategy/monteCarlo/challengeTypes";
import "./MonteCarlo.css";

interface ChallengePathsChartProps {
  result: ChallengeRawResult;
}

/**
 * Challenge Equity Paths - renders result.representativePaths (already
 * capped at ~50-100 by challengeEngine.ts - never "thousands", per spec),
 * colored by outcome (PASS = bull green, FAIL = bear red), on the same
 * "trade-index x-axis" pattern MonteCarloEquityChart.tsx already
 * established. Profit target(s) and the INITIAL drawdown floor are drawn
 * as horizontal price lines on the chart's own price scale.
 *
 * For a TRAILING drawdown challenge, the floor moves per-attempt (that's
 * the whole point of trailing DD) - drawing all ~80 paths' own moving
 * floors would be unreadable, so only the fixed INITIAL floor level is
 * shown as a reference line, with a note in the legend that the active
 * floor rises with each path's own equity (visible directly in that
 * path's own line shape, since a path terminates exactly where its
 * floor caught up with it).
 */
export function ChallengePathsChart({ result }: ChallengePathsChartProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...chartOptions(theme),
      width: containerRef.current.clientWidth,
      height: 300,
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
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 300);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = [];

    const bull = paletteColor(theme, "bull");
    const bear = paletteColor(theme, "bear");

    let anchorSeries: ISeriesApi<"Line"> | null = null;
    for (const attempt of result.representativePaths) {
      const color = attempt.outcome === "PASS" ? `${bull}CC` : `${bear}99`;
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(attempt.equityPath.map((value, i) => ({ time: i as UTCTimestamp, value })));
      seriesRef.current.push(series);
      if (!anchorSeries) anchorSeries = series;
    }

    if (anchorSeries) {
      const { accountSize, challenge } = result;
      anchorSeries.createPriceLine({
        price: accountSize * (1 + challenge.phase1.profitTargetPct / 100),
        color: paletteColor(theme, "bull"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: "Phase 1 Target",
      });
      if (challenge.phase2) {
        anchorSeries.createPriceLine({
          price: accountSize * (1 + challenge.phase2.profitTargetPct / 100),
          color: paletteColor(theme, "highlight"),
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "Phase 2 Target",
        });
      }
      anchorSeries.createPriceLine({
        price: accountSize * (1 - challenge.phase1.maxDrawdownPct / 100),
        color: paletteColor(theme, "bear"),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        title: challenge.drawdownType === "trailing" ? "Initial DD Floor" : "Max Drawdown Floor",
      });
      anchorSeries.createPriceLine({
        price: accountSize,
        color: theme === "dark" ? "rgba(230,233,239,0.4)" : "rgba(18,20,27,0.4)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        title: "Starting Balance",
      });
    }

    chart.timeScale().fitContent();
  }, [result, theme]);

  return (
    <div className="da-card">
      <div className="da-card-header">
        <span className="da-widget-title">Challenge Equity Paths</span>
        <span className="panel-dim mc-legend">
          <span className="mc-legend-swatch mc-legend-bull" /> Passed
          <span className="mc-legend-swatch mc-legend-bear" /> Failed
        </span>
      </div>
      {result.challenge.drawdownType === "trailing" && (
        <div className="panel-dim mc-trailing-note">
          Trailing drawdown: each path's own floor rises with its equity - only the initial floor level is shown as a fixed reference line above.
        </div>
      )}
      <div ref={containerRef} className="da-chart-container" style={{ height: 300 }} />
    </div>
  );
}
