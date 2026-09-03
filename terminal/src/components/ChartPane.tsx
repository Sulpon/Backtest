import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  BaselineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { dataLayer } from "../data/DataLayer";
import type { SymbolTimeframeData, Timeframe } from "../data/types";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../data/timeframes";
import { useSymbols } from "../data/useSymbols";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemeName } from "../theme/ThemeProvider";
import { useActiveWorkspace } from "../workspace/workspaceStore";
import { chartOptions, candleOptions, paletteColor, panelBackgroundColor } from "./chartTheme";
import { useChartRegistry, type ChartSnapshotWindow } from "./chartRegistry";
import { compositeSnapshot, drawTradeAnnotations } from "./chartSnapshot";
import { DrawingLayer } from "../drawing/DrawingLayer";
import { paneKey } from "../drawing/drawingStore";
import { useReplayStore } from "../replay/replayStore";
import { applyReplayCursor, computeLiveStats } from "../replay/applyCursor";
import { ReplayBar } from "../replay/ReplayBar";
import { useAnalysisStore, type SmcOverlayId } from "../analysis/analysisStore";
import { sessionBandsInRange, type SessionId } from "../analysis/sessions";
import { useSettingsStore } from "../settings/settingsStore";
import { useIndicatorStore, type IndicatorInstance } from "../indicators/indicatorStore";
import { sma, ema, bollingerBands } from "../indicators/indicators";
import { useCustomIndicatorStore, type CustomIndicator } from "../indicators/customIndicatorStore";
import { runCustomIndicator } from "../indicators/runCustomIndicator";
import { usePineIndicators } from "../pine/usePineIndicators";
import { LatestWins } from "../lib/latestWins";
import { usePineIndicatorStore } from "../pine/pineIndicatorStore";
import { PineIndicatorLayer } from "../pine/PineIndicatorLayer";
import { collectPineTrades } from "../pine/pineTradesAdapter";
import { usePineTradeOverridesStore } from "../pine/pineTradeOverridesStore";
import { nearestIndexByTime } from "../lib/bars";
import { toggleLegendIndicator } from "./indicatorLegend";
import { defaultVisibleRangeIndices } from "./chartVisibleRange";
import "./ChartPane.css";

const FVG_FORWARD_BARS = 20;

// The fast-paint window's bar count (see the fetch effect below and the
// backend's own `limit` param doc comment). Empirically sized: the
// chart's own default view is the last 300 bars, and the largest built-in
// lookback anything render-time uses against it is
// CUSTOM_INDICATOR_LOOKBACK_BARS below (200) - 3000 comfortably covers
// both plus generous scroll-back room before the full dataset (fetched
// concurrently, not after) typically lands ~1-2s later. Cuts the initial
// setData()/array-remap cost from the audit's measured ~1.1-1.3s (100k
// bars) to a small fraction of that, without truncating anything the user
// actually sees first.
const INITIAL_WINDOW_BARS = 3000;

function asTime(sec: number): Time {
  return sec as UTCTimestamp;
}

/**
 * Reuse an existing series at `index` if the pool already has one there,
 * otherwise create it. Paired with trimPool(), this turns "clear everything
 * and recreate it" into "patch the data on what's already there, only
 * touching the delta" - chart.removeSeries() turned out to cost roughly
 * 15ms per call in this library version (unrelated to how much data the
 * series holds), so redrawing ~100 overlay series on every pan/zoom/toggle
 * was costing 1.5-2 seconds. Reusing series via setData()/applyOptions()
 * instead avoids nearly all of those removeSeries() calls on the common
 * path (panning, zooming, toggling something that doesn't change how many
 * items are in view) and only pays the removal cost for the actual delta
 * when the visible item count shrinks.
 */
function getPooled<K extends "Line" | "Baseline">(pool: ISeriesApi<K>[], index: number, create: () => ISeriesApi<K>): ISeriesApi<K> {
  if (index < pool.length) return pool[index];
  const s = create();
  pool.push(s);
  return s;
}

/**
 * A secondary split-view pane doesn't own the replay cursor - it's a bar
 * index into the PRIMARY pane's (different-timeframe) dataset, so it can't
 * be used directly as an index into this pane's own bars. Converting
 * through the primary's bar timestamp and finding the nearest bar in this
 * pane's own series is what lets two different-timeframe panes stay
 * visually in sync against one shared Replay Engine, per the architecture
 * doc's "Replay Engine is the single source of truth" - the alternative
 * (a replay engine per pane) would fork that source of truth in two.
 */
function localCursorBar(ownBars: { time: number }[], primaryBarTimes: number[], cursorBar: number): number {
  const t = primaryBarTimes[cursorBar];
  if (t == null) return Math.max(0, ownBars.length - 1);
  return Math.max(0, nearestIndexByTime(ownBars, t, (b) => b.time));
}

function trimPool<K extends "Line" | "Baseline">(chart: IChartApi, pool: ISeriesApi<K>[], keep: number) {
  while (pool.length > keep) {
    const s = pool.pop();
    if (s) {
      try {
        chart.removeSeries(s);
      } catch {
        /* series already gone with the chart */
      }
    }
  }
}

export interface ChartPaneParams {
  /** Every pane owns its own symbol/timeframe - stored in dockview's own
   * panel params (not a shared workspace-level value) so each "screen" is
   * independently changeable and the choice survives layout save/restore.
   * Both undefined only for a brand-new pane, which seeds itself from the
   * workspace's own symbol/timeframe. */
  symbol?: string;
  timeframe?: Timeframe;
}

export function ChartPane(props: IDockviewPanelProps<ChartPaneParams>) {
  // "chart-1" is the one pane that drives the shared Replay Engine cursor -
  // every other pane is a read-only follower (see localCursorBar) that can
  // still have its own symbol/timeframe. Matches the hardcoded "chart-1"/
  // "chart-2" ids already used throughout applyLayout/seedLayout/commands.ts.
  const isPrimary = props.api.id === "chart-1";
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const bosPoolRef = useRef<ISeriesApi<"Line">[]>([]);
  const fvgPoolRef = useRef<ISeriesApi<"Baseline">[]>([]);
  const orderBlockPoolRef = useRef<ISeriesApi<"Baseline">[]>([]);
  const volumeImbalancePoolRef = useRef<ISeriesApi<"Baseline">[]>([]);
  const liquidityPoolRef = useRef<ISeriesApi<"Line">[]>([]);
  const tradePoolRef = useRef<ISeriesApi<"Baseline">[]>([]);
  const indicatorPoolRef = useRef<ISeriesApi<"Line">[]>([]);
  const indicatorsRef = useRef<IndicatorInstance[]>([]);
  const customIndicatorPoolRef = useRef<ISeriesApi<"Line">[]>([]);
  const customIndicatorsRef = useRef<CustomIndicator[]>([]);
  const overlayTimerRef = useRef<number | undefined>(undefined);
  const lastRangeRef = useRef<{ from: number; to: number } | null>(null);
  const dataRef = useRef<SymbolTimeframeData | null>(null); // the currently-RENDERED (possibly cursor-sliced) view
  const latestDataRef = useRef<SymbolTimeframeData | null>(null); // always the full fetched dataset
  const prevDataRef = useRef<SymbolTimeframeData | null>(null);
  const latestWinsRef = useRef<LatestWins | null>(null);
  if (!latestWinsRef.current) latestWinsRef.current = new LatestWins();
  const themeRef = useRef<ThemeName>("dark");
  const smcVisibleRef = useRef<Record<SmcOverlayId, boolean>>({
    swings: false,
    bos: false,
    choch: false,
    fvg: false,
    orderBlock: false,
    liquidity: false,
    volumeImbalance: false,
    trades: false,
  });
  const sessionsVisibleRef = useRef<Record<SessionId, boolean>>({ asian: false, london: false, newYork: false });
  const chartFontSizeRef = useRef<number>(11);

  const { theme } = useTheme();
  themeRef.current = theme;
  const smcVisible = useAnalysisStore((s) => s.smcVisible);
  smcVisibleRef.current = smcVisible;
  const sessionsVisible = useAnalysisStore((s) => s.sessionsVisible);
  sessionsVisibleRef.current = sessionsVisible;
  const chartFontSize = useSettingsStore((s) => s.chartFontSize);
  chartFontSizeRef.current = chartFontSize;
  const indicators = useIndicatorStore((s) => s.active);
  indicatorsRef.current = indicators;
  const customIndicators = useCustomIndicatorStore((s) => s.items);
  customIndicatorsRef.current = customIndicators;
  // Used only for the on-chart legend (see indicatorLegend below) - the
  // pine rendering path still sources visibility-filtered results from
  // pineResults/usePineIndicators, unchanged.
  const pineIndicatorItems = usePineIndicatorStore((s) => s.items);

  const ws = useActiveWorkspace(); // only used to seed a brand-new pane's initial symbol/timeframe
  const symbols = useSymbols();

  // This pane's own symbol/timeframe - dockview panel params are the source
  // of truth (so it round-trips through save/restore); local state mirrors
  // it for rendering and is kept in sync via onDidParametersChange below,
  // whether the change came from this pane's own header or from TopToolbar
  // acting on the currently-focused pane. Both paths only ever call
  // props.api.updateParameters() - never setState directly - so there's one
  // way to change a pane's symbol/timeframe, not two that could disagree.
  const [paneParams, setPaneParamsState] = useState<Required<ChartPaneParams>>(() => ({
    symbol: props.params?.symbol ?? ws.symbol,
    timeframe: props.params?.timeframe ?? ws.timeframe,
  }));
  const paneSymbol = paneParams.symbol;
  const paneTimeframe = paneParams.timeframe;

  useEffect(() => {
    const disposable = props.api.onDidParametersChange((p: ChartPaneParams) => {
      setPaneParamsState((prev) => ({
        symbol: p.symbol ?? prev.symbol,
        timeframe: p.timeframe ?? prev.timeframe,
      }));
    });
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    props.api.setTitle(`${paneSymbol} · ${TIMEFRAME_LABELS[paneTimeframe]}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneSymbol, paneTimeframe]);

  function setPaneSymbol(symbol: string) {
    props.api.updateParameters({ symbol, timeframe: paneTimeframe });
  }
  function setPaneTimeframe(timeframe: Timeframe) {
    props.api.updateParameters({ symbol: paneSymbol, timeframe });
  }

  const replayActive = useReplayStore((s) => s.active);
  const cursorBar = useReplayStore((s) => s.cursorBar);
  const jumpNonce = useReplayStore((s) => s.jumpNonce);
  const setDataset = useReplayStore((s) => s.setDataset);
  const primaryBarTimes = useReplayStore((s) => s.barTimes);
  // Replay-setup ("pick a candle to start here") only makes sense on the
  // pane that actually owns the shared cursor - a non-primary pane ignores
  // both, same as it already ignores the transport controls.
  const setupArmed = useReplayStore((s) => s.setupArmed) && isPrimary;
  const pendingBar = useReplayStore((s) => s.pendingBar);
  const pendingBarRef = useRef<number | null>(null);
  pendingBarRef.current = isPrimary ? pendingBar : null;
  const prevJumpNonceRef = useRef(jumpNonce);

  const [data, setData] = useState<SymbolTimeframeData | null>(null);
  // True once `data` holds the complete (unwindowed) dataset - see the
  // fetch effect below. Pine indicators, the Replay Engine, and the
  // market-structure logger must never run against the fast-paint window,
  // only ever the full history, so this gates usePineIndicators' bars arg
  // and the replay setDataset() call further down.
  const [dataIsFull, setDataIsFull] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [chartReady, setChartReady] = useState(false);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const [sessionBandRects, setSessionBandRects] = useState<{ left: number; width: number; color: string }[]>([]);
  // Chart-header OHLC/change readout (TradingView-style corner legend) -
  // just the bar INDEX, not a copied object, to keep this hover-driven
  // state update as cheap as possible; the actual OHLC/change values are
  // derived from `data.bars[hoveredBarIdx]` at render time below. null
  // means "crosshair isn't over the chart right now" - the header then
  // falls back to the last bar, same as the chart's own default view does.
  const [hoveredBarIdx, setHoveredBarIdx] = useState<number | null>(null);
  // Only ever the COMPLETE dataset, per this ref's own contract (relied on
  // by takeSnapshot() and the replay-cursor-follow effect below) - never
  // the transient fast-paint window. While only the window has landed,
  // this simply keeps pointing at whatever the previous fetch cycle left
  // it as (the prior symbol/timeframe's full data, or null on first load).
  if (dataIsFull) latestDataRef.current = data;
  // Gated on BOTH dataIsFull AND `data` actually matching the pane's
  // CURRENT symbol/timeframe - dataIsFull alone isn't enough: the instant
  // paneSymbol/paneTimeframe change, `data`/`dataIsFull` still hold the
  // PREVIOUS combo's values (nothing has set them yet), and status flips
  // to "loading" synchronously in the same tick, which by itself causes a
  // re-render - on exactly that render, `dataIsFull` would still read
  // true from the old combo, so gating on it alone let Pine keep showing
  // the old symbol's results for the ~100-150ms before the new data
  // (windowed or full) actually lands. Checking the symbol/timeframe match
  // too closes that gap: the moment the pane targets a new combo, this
  // becomes false immediately, before any fetch has even resolved.
  const dataMatchesPane = data?.symbol === paneSymbol && data?.timeframe === paneTimeframe;
  const pineResults = usePineIndicators(dataIsFull && dataMatchesPane ? data?.bars : undefined, paneSymbol, paneTimeframe);
  const removedPineTrades = usePineTradeOverridesStore((s) => s.removed);
  // A visible Pine indicator that records trades (backtest.recordTrade -
  // see interpreter.ts) takes over the pane-header stat entirely: that's
  // the whole point of exposing indicator settings that change which
  // BOS/CHoCH events count as trades - the count should visibly react.
  // Falls back to the precomputed backend stat when no Pine indicator is
  // currently producing trades. Computed here (rather than nearer its other
  // use below) so renderOverlays can also use it to hide the native,
  // Pine-unaware BOS/trade overlay once a Pine indicator supplies its own -
  // otherwise the always-static backend overlay makes toggling a Pine
  // setting look like it has no effect at all.
  const pineTrades = useMemo(() => collectPineTrades(pineResults, removedPineTrades), [pineResults, removedPineTrades]);
  const pineHasStructure = pineResults.some((r) => r.outputs.lines.length > 0);
  // A visible Pine indicator with no results YET (still computing - a full
  // 100k-bar run can take ~100s+, longer if the shared worker's queue is
  // backed up from other recent changes) vs. one that will never produce
  // any (a script with no drawing calls) look identical from pineResults
  // alone, so surface this explicitly rather than the chart just looking
  // silently empty while a run is in flight.
  const visiblePineCount = usePineIndicatorStore((s) => s.items.filter((i) => i.visible).length);
  const pineComputing = visiblePineCount > 0 && pineResults.length === 0;

  // Session shading is plain positioned <div>s, not chart series - a
  // BaselineSeries pinned at an extreme value plus autoscaleInfoProvider to
  // exclude it (the same trick used for FVG/OrderBlock boxes) turned out to
  // send the library's price-scale autoscale into a feedback loop with the
  // visible-time-range-change subscription below, pegging the CPU solid.
  // timeToCoordinate() sidesteps the price scale entirely - it only needs
  // the x pixel for each band edge - so it can't feed back into it.
  function updateSessionBands(chart: IChartApi, from: number, to: number) {
    const sv = sessionsVisibleRef.current;
    if (!Object.values(sv).some(Boolean)) {
      setSessionBandRects((prev) => (prev.length ? [] : prev));
      return;
    }
    const ts = chart.timeScale();
    const bands = sessionBandsInRange(from, to);
    const rects: { left: number; width: number; color: string }[] = [];
    for (const band of bands) {
      if (!sv[band.session.id]) continue;
      const x0 = ts.timeToCoordinate(asTime(band.start));
      const x1 = ts.timeToCoordinate(asTime(band.end));
      if (x0 == null || x1 == null) continue;
      rects.push({ left: x0, width: x1 - x0, color: band.session.color });
    }
    setSessionBandRects(rects);
  }

  // Windowed to [from, to] the same way renderOverlays' own series are -
  // swingPoints/bosEvents run into the thousands even for a single
  // symbol/timeframe, and markers outside the visible range are invisible
  // anyway, so computing/sorting/setting all of them on every data or
  // settings change was pure waste. Only ever called from inside
  // renderOverlays (which already computes from/to, and is itself already
  // wired into the chart's pan/zoom debounce), so markers stay in sync with
  // panning exactly like every other overlay already does.
  function renderMarkers(d: SymbolTimeframeData, from: number, to: number) {
    if (!markersRef.current) return;
    const t = themeRef.current;
    const sv = smcVisibleRef.current;
    const swingMarkers = sv.swings
      ? d.swingPoints
          .filter((s) => s.bar >= 0 && s.bar < d.bars.length)
          .filter((s) => {
            const bt = d.bars[s.bar].time;
            return bt >= from && bt <= to;
          })
          .map((s) => ({
            time: asTime(d.bars[s.bar].time),
            position: (s.kind === "high" ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
            color: paletteColor(t, s.kind === "high" ? "bear" : "bull"),
            shape: (s.kind === "high" ? "arrowDown" : "arrowUp") as "arrowDown" | "arrowUp",
            text: s.type,
            size: 0.6,
          }))
      : [];
    const bosMarkers = d.bosEvents
      .filter((b) => (b.kind === "choch" ? sv.choch : sv.bos))
      .filter((b) => {
        const bt = d.bars[b.barEnd]?.time;
        return bt != null && bt >= from && bt <= to;
      })
      .map((b) => ({
        time: asTime(d.bars[b.barEnd].time),
        position: "inBar" as const,
        color: b.kind === "choch" ? paletteColor(t, "highlight") : paletteColor(t, b.direction === "bull" ? "bull" : "bear"),
        shape: "circle" as const,
        text: b.kind === "choch" ? "CHoCH" : "BOS",
        size: 0.5,
      }));
    // Not windowed - a single explicit user pick, never expensive to
    // include regardless of the current view.
    const pendingBarIdx = pendingBarRef.current;
    const pickedMarker =
      pendingBarIdx != null && pendingBarIdx >= 0 && pendingBarIdx < d.bars.length
        ? [
            {
              time: asTime(d.bars[pendingBarIdx].time),
              position: "aboveBar" as const,
              color: paletteColor(t, "highlight"),
              shape: "arrowDown" as const,
              text: "Start",
              size: 1.4,
            },
          ]
        : [];
    markersRef.current.setMarkers(
      [...swingMarkers, ...bosMarkers, ...pickedMarker].sort((a, b) => (a.time as number) - (b.time as number))
    );
  }

  function clearOverlays() {
    const chart = chartRef.current;
    if (!chart) return;
    trimPool(chart, bosPoolRef.current, 0);
    trimPool(chart, fvgPoolRef.current, 0);
    trimPool(chart, orderBlockPoolRef.current, 0);
    trimPool(chart, volumeImbalancePoolRef.current, 0);
    trimPool(chart, liquidityPoolRef.current, 0);
    trimPool(chart, tradePoolRef.current, 0);
  }

  function clearIndicators() {
    const chart = chartRef.current;
    if (!chart) return;
    trimPool(chart, indicatorPoolRef.current, 0);
    trimPool(chart, customIndicatorPoolRef.current, 0);
  }

  // Windowed to [from, to] the same way BOS/FVG/session bands are, each
  // padded on the left by that indicator's own period so a moving average
  // still has its full lookback right at the window edge. The first version
  // of this recomputed every active indicator over the ENTIRE dataset (up
  // to 100k bars) on every render - cheap for a single SMA, but Bollinger
  // Bands' O(n*period) variance loop over all of it visibly froze the tab
  // for several seconds. Slicing to just what's on screen (a few hundred
  // bars, typically) fixes that regardless of how heavy an indicator is.
  function renderIndicators(chart: IChartApi, d: SymbolTimeframeData, from: number, to: number) {
    const pool = indicatorPoolRef.current;
    let idx = 0;
    const lineOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };

    for (const ind of indicatorsRef.current) {
      const fromIdx = Math.max(0, nearestIndexByTime(d.bars, from, (b) => b.time) - ind.period);
      const toIdx = Math.min(d.bars.length - 1, nearestIndexByTime(d.bars, to, (b) => b.time) + 1);
      if (toIdx <= fromIdx) continue;
      const windowBars = d.bars.slice(fromIdx, toIdx + 1);

      if (ind.type === "sma" || ind.type === "ema") {
        const points = (ind.type === "sma" ? sma : ema)(windowBars, ind.period);
        const s = getPooled(pool, idx++, () => chart.addSeries(LineSeries, { lineWidth: 2, ...lineOpts }));
        s.applyOptions({ color: ind.color, lineStyle: 0, lineWidth: 2, visible: ind.visible });
        s.setData(points.map((p) => ({ time: asTime(p.time), value: p.value })));
      } else {
        const { middle, upper, lower } = bollingerBands(windowBars, ind.period, ind.bbMult ?? 2);
        const mid = getPooled(pool, idx++, () => chart.addSeries(LineSeries, { lineWidth: 2, ...lineOpts }));
        mid.applyOptions({ color: ind.color, lineStyle: 0, lineWidth: 2, visible: ind.visible });
        mid.setData(middle.map((p) => ({ time: asTime(p.time), value: p.value })));
        const up = getPooled(pool, idx++, () => chart.addSeries(LineSeries, { lineWidth: 1, lineStyle: 2, ...lineOpts }));
        up.applyOptions({ color: ind.color, lineStyle: 2, lineWidth: 1, visible: ind.visible });
        up.setData(upper.map((p) => ({ time: asTime(p.time), value: p.value })));
        const low = getPooled(pool, idx++, () => chart.addSeries(LineSeries, { lineWidth: 1, lineStyle: 2, ...lineOpts }));
        low.applyOptions({ color: ind.color, lineStyle: 2, lineWidth: 1, visible: ind.visible });
        low.setData(lower.map((p) => ({ time: asTime(p.time), value: p.value })));
      }
    }
    trimPool(chart, pool, idx);
  }

  // Same windowing idea as renderIndicators, but with a fixed lookback pad
  // instead of a per-indicator period - custom code doesn't declare one, so
  // there's no way to know how much history it actually needs. A generous
  // fixed pad is a reasonable default; a script that needs more than that
  // (e.g. a 1000-period average) is a niche enough case not to design
  // around for v1, and it fails safe (just renders a shorter line) rather
  // than crashing.
  const CUSTOM_INDICATOR_LOOKBACK_BARS = 200;

  function renderCustomIndicators(chart: IChartApi, d: SymbolTimeframeData, from: number, to: number) {
    const pool = customIndicatorPoolRef.current;
    let idx = 0;
    const fromIdx = Math.max(0, nearestIndexByTime(d.bars, from, (b) => b.time) - CUSTOM_INDICATOR_LOOKBACK_BARS);
    const toIdx = Math.min(d.bars.length - 1, nearestIndexByTime(d.bars, to, (b) => b.time) + 1);
    const windowBars = fromIdx < toIdx ? d.bars.slice(fromIdx, toIdx + 1) : [];

    for (const ind of customIndicatorsRef.current) {
      if (!ind.visible || windowBars.length === 0) continue;
      const { points, error } = runCustomIndicator(ind.code, windowBars);
      if (error || points.length === 0) continue; // fails silently at render time - Analysis Hub surfaces errors on save
      const s = getPooled(pool, idx++, () =>
        chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      );
      s.applyOptions({ color: ind.color });
      s.setData(points.map((p) => ({ time: asTime(p.time), value: p.value })));
    }
    trimPool(chart, pool, idx);
  }

  function renderOverlays() {
    const chart = chartRef.current;
    const d = dataRef.current;
    if (!chart) return;
    if (!d) {
      clearOverlays();
      clearIndicators();
      setSessionBandRects((prev) => (prev.length ? [] : prev));
      return;
    }

    const vr = chart.timeScale().getVisibleRange();
    if (!vr) {
      clearOverlays();
      clearIndicators();
      setSessionBandRects((prev) => (prev.length ? [] : prev));
      return;
    }
    lastRangeRef.current = { from: vr.from as number, to: vr.to as number };
    const span = (vr.to as number) - (vr.from as number);
    const pad = Math.max(span, 3600) * 0.1;
    const from = (vr.from as number) - pad;
    const to = (vr.to as number) + pad;

    updateSessionBands(chart, from, to);
    renderIndicators(chart, d, from, to);
    renderCustomIndicators(chart, d, from, to);
    renderMarkers(d, from, to);

    const sv = smcVisibleRef.current;

    const bosPool = bosPoolRef.current;
    let bosIdx = 0;
    // A visible Pine indicator that draws its own structure (lines) takes
    // over this native, backend-computed overlay entirely - it never reacts
    // to Pine indicator settings, so leaving it on made toggling a Pine BOS
    // filter look like it had no effect: the static native lines dominated
    // the view while the actually-reactive Pine lines changed underneath.
    d.bosEvents.forEach((b) => {
      if (pineHasStructure) return;
      if (b.kind === "choch" ? !sv.choch : !sv.bos) return;
      const t0 = d.bars[b.barStart]?.time;
      const t1 = d.bars[b.barEnd]?.time;
      // t0 === t1 would give lightweight-charts two points at the same time,
      // which it rejects outright - can happen mid-replay when a cursor-clamped
      // trade's exit lands on the same bar as its entry (position just opened).
      if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
      const s = getPooled(bosPool, bosIdx++, () =>
        chart.addSeries(LineSeries, {
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
      );
      s.applyOptions({
        color:
          b.kind === "choch"
            ? "rgba(224,166,76,0.9)"
            : b.direction === "bull"
              ? "rgba(38,166,154,0.85)"
              : "rgba(239,83,80,0.85)",
      });
      s.setData([
        { time: asTime(t0), value: b.price },
        { time: asTime(t1), value: b.price },
      ]);
    });
    trimPool(chart, bosPool, bosIdx);

    const fvgPool = fvgPoolRef.current;
    let fvgIdx = 0;
    if (sv.fvg) {
      d.fvgEvents.forEach((f) => {
        const t0 = d.bars[f.bar]?.time;
        const endBar = Math.min(f.bar + FVG_FORWARD_BARS, d.bars.length - 1);
        const t1 = d.bars[endBar]?.time;
        if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
        const s = getPooled(fvgPool, fvgIdx++, () =>
          chart.addSeries(BaselineSeries, {
            topFillColor1: "rgba(0,188,212,0.22)",
            topFillColor2: "rgba(0,188,212,0.22)",
            bottomFillColor1: "rgba(0,188,212,0.22)",
            bottomFillColor2: "rgba(0,188,212,0.22)",
            topLineColor: "rgba(0,188,212,0.7)",
            bottomLineColor: "rgba(0,188,212,0.7)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        s.applyOptions({ baseValue: { type: "price", price: f.bottom } });
        s.setData([
          { time: asTime(t0), value: f.top },
          { time: asTime(t1), value: f.top },
        ]);
      });
    }
    trimPool(chart, fvgPool, fvgIdx);

    const orderBlockPool = orderBlockPoolRef.current;
    let orderBlockIdx = 0;
    if (sv.orderBlock) {
      d.orderBlocks.forEach((o) => {
        const t0 = d.bars[o.bar]?.time;
        const t1 = d.bars[o.barEnd]?.time;
        if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
        const s = getPooled(orderBlockPool, orderBlockIdx++, () =>
          chart.addSeries(BaselineSeries, {
            topFillColor1: "rgba(224,166,76,0.18)",
            topFillColor2: "rgba(224,166,76,0.18)",
            bottomFillColor1: "rgba(224,166,76,0.18)",
            bottomFillColor2: "rgba(224,166,76,0.18)",
            topLineColor: "rgba(224,166,76,0.7)",
            bottomLineColor: "rgba(224,166,76,0.7)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        s.applyOptions({ baseValue: { type: "price", price: o.bottom } });
        s.setData([
          { time: asTime(t0), value: o.top },
          { time: asTime(t1), value: o.top },
        ]);
      });
    }
    trimPool(chart, orderBlockPool, orderBlockIdx);

    const volumeImbalancePool = volumeImbalancePoolRef.current;
    let volumeImbalanceIdx = 0;
    if (sv.volumeImbalance) {
      d.volumeImbalanceEvents.forEach((v) => {
        const t0 = d.bars[v.bar]?.time;
        const endBar = Math.min(v.bar + FVG_FORWARD_BARS, d.bars.length - 1);
        const t1 = d.bars[endBar]?.time;
        if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
        const s = getPooled(volumeImbalancePool, volumeImbalanceIdx++, () =>
          chart.addSeries(BaselineSeries, {
            topFillColor1: "rgba(167,139,250,0.20)",
            topFillColor2: "rgba(167,139,250,0.20)",
            bottomFillColor1: "rgba(167,139,250,0.20)",
            bottomFillColor2: "rgba(167,139,250,0.20)",
            topLineColor: "rgba(167,139,250,0.7)",
            bottomLineColor: "rgba(167,139,250,0.7)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        s.applyOptions({ baseValue: { type: "price", price: v.bottom } });
        s.setData([
          { time: asTime(t0), value: v.top },
          { time: asTime(t1), value: v.top },
        ]);
      });
    }
    trimPool(chart, volumeImbalancePool, volumeImbalanceIdx);

    const liquidityPool = liquidityPoolRef.current;
    let liquidityIdx = 0;
    if (sv.liquidity) {
      d.liquidityEvents.forEach((l) => {
        const t0 = d.bars[l.barStart]?.time;
        const t1 = d.bars[l.barEnd]?.time;
        if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
        const s = getPooled(liquidityPool, liquidityIdx++, () =>
          chart.addSeries(LineSeries, {
            color: "rgba(236,72,153,0.8)",
            lineWidth: 1,
            lineStyle: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        s.setData([
          { time: asTime(t0), value: l.price },
          { time: asTime(t1), value: l.price },
        ]);
      });
    }
    trimPool(chart, liquidityPool, liquidityIdx);

    const tradePool = tradePoolRef.current;
    let tradeIdx = 0;
    // Same takeover as the BOS overlay above - once a Pine indicator is
    // producing its own trades (already reflected in the pane-header stat,
    // see pineStats below), its own zone boxes replace this native,
    // non-reactive overlay instead of both drawing simultaneously.
    if (sv.trades && pineTrades.length === 0) {
      d.trades.forEach((tr) => {
        const t0 = d.bars[tr.entryBar]?.time;
        const t1 = d.bars[tr.exitBar]?.time;
        if (t0 == null || t1 == null || t0 === t1 || t1 < from || t0 > to) return;
        // slots always alternate SL,TP,SL,TP,... across renders regardless of
        // which specific trades survive the window filter, so a reused slot's
        // role (and therefore its fill colors) never actually changes - only
        // baseValue needs refreshing per trade.
        const slS = getPooled(tradePool, tradeIdx++, () =>
          chart.addSeries(BaselineSeries, {
            topFillColor1: "rgba(239,83,80,0.28)",
            topFillColor2: "rgba(239,83,80,0.05)",
            bottomFillColor1: "rgba(239,83,80,0.05)",
            bottomFillColor2: "rgba(239,83,80,0.28)",
            topLineColor: "rgba(239,83,80,0.8)",
            bottomLineColor: "rgba(239,83,80,0.8)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        slS.applyOptions({ baseValue: { type: "price", price: tr.entryPrice } });
        slS.setData([
          { time: asTime(t0), value: tr.sl },
          { time: asTime(t1), value: tr.sl },
        ]);
        const tpS = getPooled(tradePool, tradeIdx++, () =>
          chart.addSeries(BaselineSeries, {
            topFillColor1: "rgba(38,166,154,0.28)",
            topFillColor2: "rgba(38,166,154,0.05)",
            bottomFillColor1: "rgba(38,166,154,0.05)",
            bottomFillColor2: "rgba(38,166,154,0.28)",
            topLineColor: "rgba(38,166,154,0.8)",
            bottomLineColor: "rgba(38,166,154,0.8)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
        );
        tpS.applyOptions({ baseValue: { type: "price", price: tr.entryPrice } });
        tpS.setData([
          { time: asTime(t0), value: tr.tp },
          { time: asTime(t1), value: tr.tp },
        ]);
      });
    }
    trimPool(chart, tradePool, tradeIdx);
  }


  // Milestone 3 (Telegram trade review) - see chartRegistry.ts/
  // chartSnapshot.ts for the surrounding design. Reuses this exact
  // component's own chart/series/overlay-rendering rather than a second
  // renderer: temporarily frames the requested window, forces a synchronous
  // overlay/marker re-render (renderOverlays is normally reached via the
  // chart's own 80ms-debounced pan/zoom handler - a screenshot can't wait
  // on that), waits a couple of animation frames for the canvas to actually
  // paint, screenshots, then restores exactly what was visible before.
  //
  // During active replay, dataRef.current only holds the cursor-sliced
  // dataset (see the replay-cursor effect below) - a trade past the
  // current cursor wouldn't even be in the series yet, so this temporarily
  // swaps in the full dataset for the capture and swaps the sliced view
  // back afterward, exactly mirroring how the replay-cursor effect itself
  // pushes data into the series.
  async function takeSnapshot(snapshotWindow: ChartSnapshotWindow): Promise<string> {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const full = latestDataRef.current;
    if (!chart || !series || !full) throw new Error("Chart is not ready yet");
    // latestDataRef only ever holds a COMPLETE dataset (see its own doc
    // comment), but during the brief window right after a symbol/timeframe
    // switch it can still be the PREVIOUS one - the fast-paint window has
    // already repainted the chart and updated chartRegistry's symbol/
    // timeframe for this pane, but the full dataset for the NEW combo
    // hasn't landed yet. Guard against capturing (and mislabeling) the old
    // symbol's chart under the new one's name - same reasoning as the Pine
    // staleness fix.
    if (full.symbol !== paneSymbol || full.timeframe !== paneTimeframe) {
      throw new Error("Chart is still loading this symbol/timeframe - try again in a moment");
    }

    const wasReplaySliced = dataRef.current !== full;
    const renderedBeforeCapture = dataRef.current;
    const originalRange = chart.timeScale().getVisibleRange();

    if (wasReplaySliced) {
      dataRef.current = full;
      series.setData(full.bars.map((b) => ({ ...b, time: asTime(b.time) })));
    }

    // A trade-review snapshot always renders dark, and always shows the
    // structure that led into the trade, regardless of whatever theme/
    // toggles the user currently happens to have live - that's the whole
    // point of a review image, not an accident of whatever was last
    // clicked. Overriding the REFS (not analysisStore/ThemeProvider
    // themselves) means this never touches the real theme toggle or
    // Analysis Hub checkboxes or triggers a re-render of them - purely a
    // capture-time override, restored in the finally block below
    // regardless of how capture finishes.
    const originalTheme = themeRef.current;
    themeRef.current = "dark";
    chart.applyOptions(chartOptions("dark", chartFontSizeRef.current));
    series.applyOptions(candleOptions("dark"));
    const originalSmcVisible = smcVisibleRef.current;
    smcVisibleRef.current = { ...originalSmcVisible, bos: true, choch: true };

    // setVisibleRange() does not take effect synchronously - reading
    // getVisibleRange() immediately after still returns the OLD range;
    // lightweight-charts only applies it on its own next internal tick.
    // Every other caller of setVisibleRange() in this component gets away
    // without knowing that because the chart's own visibleTimeRangeChange
    // event eventually fires and the existing 80ms-debounced scheduleOverlay
    // (above) re-renders overlays for the real new range shortly after -
    // invisible in normal use, but a screenshot can't just hope to win that
    // race. Waiting for the SAME event here (instead of a fixed delay,
    // which would be exactly as fragile) is what makes renderOverlays()
    // below compute its from/to window against the range that's actually
    // about to be painted, not a stale one - confirmed via direct
    // reproduction: without this wait, BOS/FVG series were being created
    // against the OLD (pre-snapshot) visible window and ended up
    // positioned entirely outside the frame that was actually captured.
    await new Promise<void>((resolve) => {
      // Safety net, not the primary signal: if the requested window happens
      // to exactly match what's already visible, the range genuinely never
      // "changes" and this event would never fire - a fixed fallback delay
      // here only guards that edge case, it isn't relied on for the normal
      // case above.
      const timeScale = chart.timeScale();
      const timeout = window.setTimeout(resolve, 500);
      function onRangeChanged() {
        timeScale.unsubscribeVisibleTimeRangeChange(onRangeChanged);
        window.clearTimeout(timeout);
        resolve();
      }
      timeScale.subscribeVisibleTimeRangeChange(onRangeChanged);
      timeScale.setVisibleRange({ from: asTime(snapshotWindow.fromTime), to: asTime(snapshotWindow.toTime) });
    });
    renderOverlays();
    // a couple of frames for the canvas to actually paint the new series
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    try {
      const chartCanvas = chart.takeScreenshot();
      const pineCanvas = bodyEl?.querySelector<HTMLCanvasElement>(".pine-indicator-layer-canvas") ?? null;

      let annotationCanvas: HTMLCanvasElement | null = null;
      const rt = snapshotWindow.reviewedTrade;
      if (rt) {
        const dpr = window.devicePixelRatio || 1;
        const widthPx = chartCanvas.width / dpr;
        const heightPx = chartCanvas.height / dpr;
        const timeScale = chart.timeScale();
        // Extends exactly [entryTime, exitTime] - the trade's own real
        // duration - not the wider snapshot window (a short trade filling
        // the whole window would misrepresent how long it was actually
        // open).
        const leftPx = timeScale.timeToCoordinate(asTime(rt.entryTime));
        const rightPx = timeScale.timeToCoordinate(asTime(rt.exitTime));
        const entryPx = series.priceToCoordinate(rt.entryPrice);
        const slPx = series.priceToCoordinate(rt.sl);
        const tpPx = series.priceToCoordinate(rt.tp);
        if (leftPx != null && rightPx != null && entryPx != null && slPx != null && tpPx != null) {
          annotationCanvas = drawTradeAnnotations(widthPx, heightPx, dpr, {
            leftPx,
            rightPx,
            entryPx,
            slPx,
            tpPx,
            setupLabel: rt.setup,
          });
        }
      }

      return compositeSnapshot(chartCanvas, pineCanvas, annotationCanvas, panelBackgroundColor("dark"));
    } finally {
      themeRef.current = originalTheme;
      chart.applyOptions(chartOptions(originalTheme, chartFontSizeRef.current));
      series.applyOptions(candleOptions(originalTheme));
      smcVisibleRef.current = originalSmcVisible;
      if (wasReplaySliced && renderedBeforeCapture) {
        dataRef.current = renderedBeforeCapture;
        series.setData(renderedBeforeCapture.bars.map((b) => ({ ...b, time: asTime(b.time) })));
      }
      if (originalRange) chart.timeScale().setVisibleRange(originalRange);
      renderOverlays();
    }
  }

  const REPLAY_WINDOW_BARS = 150;

  // Keeps the cursor comfortably in view during replay. Always recomputes an
  // ABSOLUTE range from the bar data rather than shifting the previous range
  // by a delta - incremental shifting compounds any mismatch between the
  // range you asked for and what the chart actually settles on (it can clamp
  // to available data), which drifted the window shut over many small steps.
  // On a jump (force=true) this always repositions; on a step/tick it only
  // repositions if the cursor has actually drifted out of a comfortable
  // zone, so a manual zoom made mid-replay isn't undone on every tick.
  function frameReplayCursor(chart: IChartApi, full: SymbolTimeframeData, bar: number, force: boolean) {
    const cursorTime = full.bars[bar].time;
    if (!force) {
      const vr = chart.timeScale().getVisibleRange();
      if (vr) {
        const span = (vr.to as number) - (vr.from as number);
        const rightMargin = span * 0.15;
        const comfortable = cursorTime >= (vr.from as number) && cursorTime <= (vr.to as number) - rightMargin;
        if (comfortable) return;
      }
    }
    const from = Math.max(0, bar - REPLAY_WINDOW_BARS);
    const to = Math.min(full.bars.length - 1, bar + Math.round(REPLAY_WINDOW_BARS * 0.2));
    chart.timeScale().setVisibleRange({ from: asTime(full.bars[from].time), to: asTime(full.bars[to].time) });
  }

  // create the chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...chartOptions(themeRef.current, chartFontSizeRef.current),
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, candleOptions(themeRef.current));
    const markers = createSeriesMarkers(series, []);
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = markers;
    setChartReady(true);

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    });
    ro.observe(containerRef.current);

    const scheduleOverlay = () => {
      window.clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = window.setTimeout(() => {
        // Adding/removing a batch of series (BOS lines, indicator lines, ...)
        // can itself fire a spurious visible-time-range-change "echo" even
        // when the range value hasn't actually moved - without this guard,
        // that echo re-triggers renderOverlays(), whose own series churn
        // fires another echo, and so on for several rounds before settling.
        // Each round is cheap alone, but 4-5 of them back to back was
        // visibly janky. Skipping when the range is unchanged from the last
        // time THIS debounce fired breaks the chain at its source.
        const vr = chartRef.current?.timeScale().getVisibleRange();
        if (vr) {
          const f = vr.from as number;
          const t = vr.to as number;
          if (lastRangeRef.current && lastRangeRef.current.from === f && lastRangeRef.current.to === t) return;
          lastRangeRef.current = { from: f, to: t };
        }
        renderOverlays();
      }, 80);
    };
    chart.timeScale().subscribeVisibleTimeRangeChange(scheduleOverlay);

    // Replay-setup's "click a candle to start here" - only the pane that
    // owns the shared cursor accepts picks, and only while armed, so a
    // stray click during normal chart use never does anything. Reads the
    // engine directly via getState() rather than a dep-array subscription,
    // same reasoning as DrawingLayer's tool-click handling: this callback
    // is registered once at mount, so it needs the CURRENT armed state at
    // click time, not whatever it was when the effect first ran.
    function onChartClick(param: { time?: Time; point?: { x: number } }) {
      if (!isPrimary) return;
      const replay = useReplayStore.getState();
      if (!replay.setupArmed) return;
      const bars = dataRef.current?.bars ?? latestDataRef.current?.bars;
      if (!bars || bars.length === 0) return;
      const clickTime = (param.time as number | undefined) ?? chart.timeScale().coordinateToTime(param.point?.x ?? -1);
      if (clickTime == null) return;
      const bar = nearestIndexByTime(bars, clickTime as number, (b) => b.time);
      if (bar >= 0) replay.pickBar(bar);
    }
    chart.subscribeClick(onChartClick);

    // Chart-header OHLC readout - native subscribeCrosshairMove, same
    // mount/cleanup shape as onChartClick above. Only ever calls React
    // setState (a plain number or null) - never touches dataRef/seriesRef,
    // so this can't race or interfere with any of the mutable-ref-driven
    // effects elsewhere in this component.
    function onCrosshairMove(param: { time?: Time }) {
      if (!param.time) {
        setHoveredBarIdx(null);
        return;
      }
      const bars = dataRef.current?.bars ?? latestDataRef.current?.bars;
      if (!bars || bars.length === 0) {
        setHoveredBarIdx(null);
        return;
      }
      const idx = nearestIndexByTime(bars, param.time as number, (b) => b.time);
      setHoveredBarIdx(idx >= 0 ? idx : null);
    }
    chart.subscribeCrosshairMove(onCrosshairMove);

    return () => {
      ro.disconnect();
      chart.unsubscribeClick(onChartClick);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Registers this pane with the chart registry (see chartRegistry.ts) so
  // a non-chart component (the trade journal's "Send to Telegram" button)
  // can find "the mounted pane currently showing symbol X on timeframe Y"
  // and request a snapshot from it. Re-registers whenever the pane's own
  // symbol/timeframe/data changes so the registry entry never points at a
  // stale takeSnapshot closure; unregisters on unmount so a closed pane
  // can't be found.
  useEffect(() => {
    if (!chartReady || !data) return;
    const paneId = props.api.id;
    useChartRegistry.getState().register(paneId, { symbol: paneSymbol, timeframe: paneTimeframe, takeSnapshot });
    return () => useChartRegistry.getState().unregister(paneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartReady, data, paneSymbol, paneTimeframe]);

  // re-theme on theme change (colors come from the theme string directly,
  // not from computed CSS - see chartTheme.ts for why); also re-run whenever
  // an Analysis-hub SMC or session toggle flips, since that changes what
  // renderMarkers/renderOverlays draw without any chart-native trigger to
  // catch it, whenever the chart font size setting or the active
  // built-in/custom indicator list changes, and whenever the replay-setup
  // picked bar changes (the "Start" marker renderMarkers draws for it)
  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions(theme, chartFontSize));
    seriesRef.current?.applyOptions(candleOptions(theme));
    renderOverlays(); // also renders markers - see renderMarkers' own doc comment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, smcVisible, sessionsVisible, chartFontSize, indicators, customIndicators, pendingBar]);

  // fetch data on symbol/timeframe change. Normally two requests fire
  // concurrently: a small, fast window for an immediate paint, and the
  // full history that every other feature (replay, Pine, market-structure
  // logging) actually needs. Whichever lands can update the chart's
  // candles/native overlays, but the full fetch always wins if both are in
  // flight - fullArrived stops a slower windowed response from downgrading
  // an already-applied complete dataset back to a partial one, and
  // LatestWins (see that module's doc comment) stops a stale response from
  // EITHER request (windowed or full) landing after the user has already
  // switched to a different symbol/timeframe from overwriting what's on
  // screen now - exactly the "EURUSD resolves after GBPUSD was applied"
  // race.
  //
  // When the full dataset is ALREADY cached (revisiting a symbol/timeframe
  // this session), the windowed fetch is skipped entirely - firing it
  // anyway would cost a real network round-trip AND a second wasted
  // render pass moments before the already-available full data replaces
  // it. This is what makes a warm revisit close to instant rather than
  // merely fast.
  useEffect(() => {
    setStatus("loading");
    // dataIsFull is deliberately NOT reset here - see each handler below.
    // Resetting it eagerly, before either fetch has resolved, caused the
    // [data, dataIsFull] effect to re-run immediately with the PREVIOUS
    // combo's `data` paired with a new dataIsFull=false, re-applying
    // (setData + renderOverlays, ~150-200ms wasted on a 100k-bar dataset)
    // data that hadn't actually changed - measured while chasing down why
    // a fully-cached warm switch wasn't as fast as the cache-hit alone
    // should make it. Leaving it untouched means dataIsFull only ever
    // changes at the exact moment `data` does, alongside it.
    const token = latestWinsRef.current!.start();
    let fullArrived = false;
    // Set only by the disk-cache branch below, once a prior-session snapshot
    // has actually been applied - guards the windowed branch further down so
    // it doesn't downgrade an already-painted (if possibly stale) full-shape
    // dataset back to a partial windowed one moments later.
    let diskCacheArrived = false;

    if (!dataLayer.hasCachedSymbolData(paneSymbol, paneTimeframe)) {
      // Best-effort, possibly-stale disk snapshot from a prior session (see
      // getCachedSymbolDataFromDisk's doc comment) - purely a faster paint
      // for a warm reload of a previously-visited symbol/timeframe. Never
      // treated as equivalent to a network-verified full fetch: dataIsFull
      // is deliberately NOT set true here, so replay registration, total-
      // bar-count logic, and market-structure-dataset stats/logging all
      // still wait for the real getSymbolData() call below, exactly as
      // today.
      dataLayer.getCachedSymbolDataFromDisk(paneSymbol, paneTimeframe).then((cached) => {
        if (!token.isCurrent() || fullArrived || !cached) return;
        diskCacheArrived = true;
        setData(cached);
        setStatus("ready");
      });

      dataLayer
        .getSymbolDataWindowed(paneSymbol, paneTimeframe, INITIAL_WINDOW_BARS)
        .then((d) => {
          if (!token.isCurrent() || fullArrived || diskCacheArrived) return;
          setData(d);
          setDataIsFull(false);
          setStatus("ready");
        })
        .catch(() => {
          // The full fetch below is the one that surfaces a real failure -
          // a failed fast-window fetch alone must never flip the pane to
          // an error state while the full fetch might still succeed.
        });
    }

    dataLayer
      .getSymbolData(paneSymbol, paneTimeframe)
      .then((d) => {
        if (!token.isCurrent()) return;
        fullArrived = true;
        setData(d);
        setDataIsFull(true);
        setStatus("ready");
      })
      .catch(() => {
        if (token.isCurrent()) setStatus("error");
      });
  }, [paneSymbol, paneTimeframe]);

  // a fresh dataset arrived (windowed OR full - this runs for both, since
  // both need their candles/overlays painted): register it with the
  // Replay Engine (which resets any prior cursor - bar indices from a
  // different symbol/timeframe don't apply), push the series, and set the
  // default view. A non-primary pane never registers - it only ever reads
  // the primary pane's cursor (converted to its own bar index below),
  // never owns it. Replay registration itself is gated on dataIsFull: it
  // needs the TRUE total bar count and trade list, which the fast-paint
  // window's truncated arrays don't have - registering against those
  // would give replay a wrong totalBars (and reset the cursor a second,
  // pointless time moments later when the full dataset lands anyway).
  useEffect(() => {
    if (!data || !seriesRef.current || !markersRef.current || !chartRef.current) return;
    prevDataRef.current = data;
    if (isPrimary && dataIsFull) {
      setDataset(
        data.bars.length,
        data.bars.map((b) => b.time),
        data.trades.map((t) => t.entryBar)
      );
    }

    dataRef.current = data;
    seriesRef.current.setData(data.bars.map((b) => ({ ...b, time: asTime(b.time) })));

    // null for zero bars (a pane can legitimately have no data - see
    // defaultVisibleRangeIndices's own doc comment) - nothing meaningful to
    // set a visible range to, so skip it rather than index an empty array.
    const range = defaultVisibleRangeIndices(data.bars.length);
    if (range) {
      chartRef.current.timeScale().setVisibleRange({ from: asTime(data.bars[range.from].time), to: asTime(data.bars[range.to].time) });
    }

    renderOverlays(); // also renders markers, windowed to the range just set above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dataIsFull]);

  // A Pine indicator's "Apply From Date" (see PineSettingsDialog) governs
  // where a fresh dataset's default view starts, once one is set - without
  // this, the chart still opens on the last-300-bars window above, and the
  // structure/trades that indicator computes from years earlier are only
  // reachable by manually scrolling back to find them.
  const activeStartDate = pineResults.find((r) => r.indicator.startDate)?.indicator.startDate ?? null;
  useEffect(() => {
    if (!chartRef.current || !data || activeStartDate == null) return;
    const idx = data.bars.findIndex((b) => b.time >= activeStartDate);
    if (idx < 0) return;
    // Same window WIDTH as the plain last-300-bars default view above, just
    // anchored at the start date instead of at "now" - spanning all the way
    // to the dataset's end (years of hourly bars) would need far less than
    // one pixel per candle to fit, which lightweight-charts' minimum bar
    // spacing rejects outright (confirmed: setVisibleRange silently no-ops
    // and the range stays wherever it was). The user can still pan/zoom out
    // from here same as any other view.
    const last = data.bars.length - 1;
    const to = Math.min(idx + 300, last);
    chartRef.current.timeScale().setVisibleRange({ from: asTime(data.bars[idx].time), to: asTime(data.bars[to].time) });
  }, [activeStartDate, data]);

  // the replay cursor moved (or replay was entered/exited): push the
  // cursor-sliced (or full) view without touching the user's zoom, only a
  // gentle auto-follow while actively replaying
  useEffect(() => {
    const full = latestDataRef.current;
    if (!full || !seriesRef.current || !markersRef.current || !chartRef.current) return;
    if (full !== prevDataRef.current) return; // the [data] effect above will handle a genuinely new dataset

    const localBar = isPrimary ? cursorBar : localCursorBar(full.bars, primaryBarTimes, cursorBar);
    const effective = replayActive ? applyReplayCursor(full, localBar) : full;
    dataRef.current = effective;
    seriesRef.current.setData(effective.bars.map((b) => ({ ...b, time: asTime(b.time) })));
    renderOverlays(); // also renders markers
    if (replayActive) {
      frameReplayCursor(chartRef.current, full, localBar, jumpNonce !== prevJumpNonceRef.current);
    }
    prevJumpNonceRef.current = jumpNonce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayActive, cursorBar, jumpNonce]);

  // for a non-primary pane this is the primary's cursor converted to THIS
  // pane's own bar index - showing the raw primary index in the replay
  // badge would be meaningless once the two panes are on different
  // symbols/timeframes (bar 300 on a 1H pane is a different moment than bar
  // 300 on a 1D one, let alone a different instrument entirely).
  const localReplayBar = !isPrimary && data ? localCursorBar(data.bars, primaryBarTimes, cursorBar) : cursorBar;

  const liveStats = useMemo(() => {
    if (!replayActive || !data) return null;
    const resolved = data.trades.filter((t) => t.exitBar <= localReplayBar);
    return computeLiveStats(resolved, data.stats?.rr ?? 2.45);
  }, [replayActive, localReplayBar, data]);

  // pineTrades is computed earlier (near pineResults) so renderOverlays can
  // also use it - see the comment there.
  const pineStats = useMemo(() => (pineTrades.length > 0 ? computeLiveStats(pineTrades, data?.stats?.rr ?? 2.45) : null), [pineTrades, data]);

  // Gated on dataMatchesPane (see that flag's own doc comment near
  // pineResults above) for the same reason Pine is: `data` (and so
  // data.stats/data.trades) still holds the PREVIOUS symbol/timeframe's
  // values for the brief window between paneSymbol/paneTimeframe changing
  // and the new fetch actually landing. Without this, the header briefly
  // showed the old symbol's own native trade count/win-rate under the new
  // symbol's candles - smaller and shorter-lived than the Pine bug this
  // was modeled after (a few hundred ms of network time, not ~20s of
  // interpreter time), but the same class of "stale data presented as
  // current" the user asked to eliminate everywhere, not just for Pine.
  const displayStats = dataMatchesPane ? (pineStats ?? liveStats ?? data?.stats ?? null) : null;

  // Chart-header OHLC/change readout. Mirrors applyReplayCursor's own
  // `bars.slice(0, cursorBar + 1)` (replay/applyCursor.ts) using already-
  // reactive state (`data`, `replayActive`, `localReplayBar`) rather than
  // reading dataRef/seriesRef directly - a ref mutation alone doesn't
  // trigger a re-render, so reading refs here would show a stale bar until
  // some unrelated re-render happened to catch it up. Falls back to the
  // last visible bar (exactly what the candle series itself currently
  // ends on) whenever the crosshair isn't over the chart.
  const headerBars = dataMatchesPane && data ? (replayActive ? data.bars.slice(0, localReplayBar + 1) : data.bars) : null;
  const headerIdx = headerBars && headerBars.length > 0 ? Math.min(hoveredBarIdx ?? headerBars.length - 1, headerBars.length - 1) : null;
  const headerBar = headerIdx != null ? headerBars![headerIdx] : null;
  const headerPrevBar = headerIdx != null && headerIdx > 0 ? headerBars![headerIdx - 1] : null;
  const headerChange = headerBar && headerPrevBar ? headerBar.close - headerPrevBar.close : null;
  const headerChangePct = headerChange != null && headerPrevBar && headerPrevBar.close !== 0 ? (headerChange / headerPrevBar.close) * 100 : null;

  // Active-indicator legend (color dot + name), interactive: clicking a
  // chip toggles that indicator's visibility via the owning store, mirroring
  // TradingView's legend eye toggle. Pine entries are read directly from
  // pineIndicatorStore's items (not pineResults, which is already filtered
  // to visible-only upstream in usePineIndicators.ts) so hidden Pine
  // indicators still show up here, dimmed, with a way to re-enable them.
  const indicatorLegend = [
    ...indicators.map((ind) => ({ id: `builtin-${ind.id}`, label: ind.type === "sma" || ind.type === "ema" ? `${ind.type.toUpperCase()} ${ind.period}` : `BB ${ind.period}`, color: ind.color, visible: ind.visible })),
    ...customIndicators.map((ind) => ({ id: `custom-${ind.id}`, label: ind.name, color: ind.color, visible: ind.visible })),
    ...pineIndicatorItems.map((ind) => ({ id: `pine-${ind.id}`, label: ind.name, color: "#4f8cff", visible: ind.visible })),
  ];

  return (
    <div className="chart-pane">
      <div className="pane-header">
        <select value={paneSymbol} onChange={(e) => setPaneSymbol(e.target.value)} title="Instrument">
          {(symbols.length ? symbols : [paneSymbol]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="pane-tf">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className={tf === paneTimeframe ? "active" : ""}
              onClick={() => setPaneTimeframe(tf)}
            >
              {TIMEFRAME_LABELS[tf]}
            </button>
          ))}
        </div>
        {headerBar && (
          <div className="pane-ohlc mono">
            <span className="pane-ohlc-item">O<b>{headerBar.open.toFixed(5)}</b></span>
            <span className="pane-ohlc-item">H<b>{headerBar.high.toFixed(5)}</b></span>
            <span className="pane-ohlc-item">L<b>{headerBar.low.toFixed(5)}</b></span>
            <span className="pane-ohlc-item">C<b>{headerBar.close.toFixed(5)}</b></span>
            {headerChange != null && headerChangePct != null && (
              <span className={headerChange >= 0 ? "pos" : "neg"}>
                {headerChange >= 0 ? "+" : ""}
                {headerChange.toFixed(5)} ({headerChangePct >= 0 ? "+" : ""}
                {headerChangePct.toFixed(2)}%)
              </span>
            )}
          </div>
        )}
        {indicatorLegend.length > 0 && (
          <div className="pane-indicator-legend">
            {indicatorLegend.map((ind) => (
              <button
                key={ind.id}
                type="button"
                className={`pane-indicator-chip${ind.visible ? "" : " hidden"}`}
                title={`${ind.label} - click to ${ind.visible ? "hide" : "show"}`}
                onClick={() => toggleLegendIndicator(ind.id)}
              >
                <span className="pane-indicator-dot" style={{ background: ind.color }} />
                {ind.label}
              </button>
            ))}
          </div>
        )}
        {replayActive && (
          <span className="pane-replay-badge">{isPrimary ? `REPLAY · bar ${localReplayBar + 1}` : "REPLAY · linked"}</span>
        )}
        {setupArmed && <span className="pane-replay-badge pane-replay-badge-setup">SELECT REPLAY START</span>}
        {pineComputing && <span className="pane-replay-badge" title="A Pine indicator is running over the full dataset - this can take a minute or more">Computing Pine indicator…</span>}
        {displayStats && (
          <div className="pane-stats mono">
            <span>{displayStats.total} trades</span>
            <span>{displayStats.winRate.toFixed(1)}% WR</span>
            <span className={displayStats.expectancy >= 0 ? "pos" : "neg"}>
              {displayStats.expectancy >= 0 ? "+" : ""}
              {displayStats.expectancy.toFixed(2)}R
            </span>
          </div>
        )}
      </div>
      <div className="pane-body" ref={setBodyEl}>
        <div ref={containerRef} className={`pane-chart${setupArmed ? " replay-picking" : ""}`} />
        <div className="pane-session-bands">
          {sessionBandRects.map((r, i) => (
            <div key={i} className="pane-session-band" style={{ left: r.left, width: Math.max(r.width, 1), background: r.color }} />
          ))}
        </div>
        {chartReady && bodyEl && data && chartRef.current && seriesRef.current && (
          <PineIndicatorLayer
            containerEl={bodyEl}
            chart={chartRef.current}
            series={seriesRef.current}
            results={pineResults}
          />
        )}
        {chartReady && bodyEl && data && chartRef.current && seriesRef.current && (
          <DrawingLayer
            containerEl={bodyEl}
            chart={chartRef.current}
            series={seriesRef.current}
            bars={data.bars}
            paneKey={paneKey(paneSymbol, paneTimeframe)}
          />
        )}
        {status === "loading" && <div className="pane-overlay-msg">Loading {paneSymbol}…</div>}
        {status === "error" && <div className="pane-overlay-msg error">Couldn't load data for {paneSymbol}</div>}
        {isPrimary && <ReplayBar />}
      </div>
    </div>
  );
}
