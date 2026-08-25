import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { CandleBar } from "../data/types";
import type { PineRunResult } from "./usePineIndicators";
import { pineColorToCss } from "./stdlib";
import { useUiStore } from "../workspace/uiStore";
import { DRAWING_KINDS } from "../drawing/kinds";
import type { DrawingType } from "../drawing/types";
import { distToSegment, pointInRect } from "../drawing/geometry";
import { usePineTradeOverridesStore } from "./pineTradeOverridesStore";
import "./PineIndicatorLayer.css";

interface PineIndicatorLayerProps {
  containerEl: HTMLDivElement;
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  results: PineRunResult[];
}

interface Scale {
  x(time: number): number | null;
  y(price: number): number | null;
  width: number;
  height: number;
}

const HIT_PX = 6;

/** Converts a Pine `bar_index` (an index into the windowed `bars` array
 * the script ran against) to a unix-seconds time the chart can place. Bar
 * indices past the end of the array (rare - a script referencing a
 * near-future bar) extrapolate using the dataset's own average bar
 * spacing rather than failing to render. */
export function barIndexToTime(idx: number, bars: CandleBar[], avgInterval: number): number {
  if (bars.length === 0 || !Number.isFinite(idx)) return 0;
  // Real Pine tolerates a fractional bar_index (some scripts compute one,
  // e.g. averaging two box edges without rounding) by interpolating -
  // array indexing doesn't, so round rather than crash on a non-integer.
  const i = Math.round(idx);
  if (i >= 0 && i < bars.length) return bars[i].time;
  if (i >= bars.length) return bars[bars.length - 1].time + (i - (bars.length - 1)) * avgInterval;
  return bars[0].time + i * avgInterval;
}

export function avgBarInterval(bars: CandleBar[]): number {
  if (bars.length < 2) return 3600;
  return (bars[bars.length - 1].time - bars[0].time) / (bars.length - 1);
}

/** Extends a horizontal segment's pixel endpoints out to the canvas edges
 * along its own slope - same idea as the drawing tools' trend-line extend,
 * reimplemented locally so this module doesn't depend on drawing/kinds.ts
 * (Pine indicators and user drawings are deliberately independent systems). */
function extendToEdges(
  ax: number, ay: number, bx: number, by: number, width: number,
  extendLeft: boolean, extendRight: boolean
): [number, number, number, number] {
  if (!extendLeft && !extendRight) return [ax, ay, bx, by];
  const dx = bx - ax;
  if (dx === 0) return [ax, ay, bx, by];
  const dy = by - ay;
  const leftIsA = ax <= bx;
  let [x1, y1, x2, y2] = [ax, ay, bx, by];
  if (extendLeft) {
    const targetX = leftIsA ? 0 : width;
    const t = (targetX - ax) / dx;
    if (leftIsA) [x1, y1] = [targetX, ay + t * dy];
    else [x2, y2] = [targetX, ay + t * dy];
  }
  if (extendRight) {
    const targetX = leftIsA ? width : 0;
    const t = (targetX - ax) / dx;
    if (leftIsA) [x2, y2] = [targetX, ay + t * dy];
    else [x1, y1] = [targetX, ay + t * dy];
  }
  return [x1, y1, x2, y2];
}

function setLineDash(ctx: CanvasRenderingContext2D, style: string) {
  if (style === "dashed") ctx.setLineDash([6, 4]);
  else if (style === "dotted") ctx.setLineDash([1.5, 3]);
  else ctx.setLineDash([]);
}

/** Shared between rendering and hit-testing so the clickable area always
 * matches what's actually drawn - see the label loop in draw() and the
 * label branch in hitTestPine(). `style: "none"` (Pine's label.style_none)
 * is real text-only-no-shape, not a placeholder default - a script that
 * asks for it (as both target SMC scripts do for every fib label) is
 * deliberately avoiding a background pill entirely, so it gets no box at
 * all rather than a smaller/invisible one. */
function computeLabelBox(ctx: CanvasRenderingContext2D, text: string, px: number, py: number, style: string) {
  ctx.font = "10px 'IBM Plex Mono', monospace";
  const metrics = ctx.measureText(text);
  const padX = 5;
  const padY = 3;
  const boxW = metrics.width + padX * 2;
  const boxH = 14 + padY;
  if (style === "none") {
    // Text centered directly on the anchor point - no pointer, no pill.
    return { bx: px - boxW / 2, by: py - boxH / 2, boxW, boxH, hasBox: false };
  }
  let bx = px - boxW / 2;
  let by = py - boxH - 6;
  if (style === "label_up") by = py + 6;
  if (style === "label_right") {
    bx = px + 6;
    by = py - boxH / 2;
  }
  if (style === "label_left") {
    bx = px - boxW - 6;
    by = py - boxH / 2;
  }
  return { bx, by, boxW, boxH, hasBox: true };
}

interface TradeMenuState {
  x: number;
  y: number;
  tradeId: string;
}

export function PineIndicatorLayer({ containerEl, chart, series, results }: PineIndicatorLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const [tradeMenu, setTradeMenu] = useState<TradeMenuState | null>(null);

  function buildScale(width: number, height: number): Scale {
    return {
      x: (t) => chart.timeScale().timeToCoordinate(t as Time),
      y: (p) => series.priceToCoordinate(p),
      width,
      height,
    };
  }

  useEffect(() => {
    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    function draw() {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const scale = buildScale(w, h);
      const removedTradeIds = usePineTradeOverridesStore.getState().removed;

      for (const result of resultsRef.current) {
        // Each indicator can have its own startDate ("apply from"), which
        // slices its OWN windowedBars before the interpreter ever sees
        // earlier history - so bar_index -> time must use THIS result's
        // own bars, never a shared/full-dataset array (that would place
        // every drawing at the wrong date for a filtered indicator).
        const bars = result.windowedBars;
        if (bars.length === 0) continue;
        const avgInterval = avgBarInterval(bars);
        const toTime = (xlocValue: number, xloc: string) =>
          xloc === "bar_time" ? xlocValue / 1000 : barIndexToTime(xlocValue, bars, avgInterval);
        const { boxes, lines, labels, plots } = result.outputs;

        for (const box of boxes) {
          const b = box as Record<string, unknown>;
          if (typeof b.tradeId === "string" && removedTradeIds[b.tradeId]) continue;
          const leftT = toTime(b.left as number, b.xloc as string);
          const rightT = toTime(b.right as number, b.xloc as string);
          const x0raw = scale.x(leftT);
          const x1raw = scale.x(rightT);
          const y0 = scale.y(b.top as number);
          const y1 = scale.y(b.bottom as number);
          if (x0raw == null || x1raw == null || y0 == null || y1 == null) continue;
          const extend = String(b.extend ?? "none");
          let x0 = Math.min(x0raw, x1raw);
          let x1 = Math.max(x0raw, x1raw);
          if (extend === "left" || extend === "both") x0 = 0;
          if (extend === "right" || extend === "both") x1 = scale.width;
          ctx.fillStyle = pineColorToCss(b.bgColor, "rgba(79,140,255,0.1)");
          ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
          const borderWidth = Number(b.borderWidth ?? 1);
          if (borderWidth > 0) {
            ctx.strokeStyle = pineColorToCss(b.borderColor, "#e7ebf3");
            ctx.lineWidth = borderWidth;
            setLineDash(ctx, String(b.borderStyle ?? "solid"));
            ctx.strokeRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
            ctx.setLineDash([]);
          }
        }

        for (const line of lines) {
          const l = line as Record<string, unknown>;
          const t1 = toTime(l.x1 as number, l.xloc as string);
          const t2 = toTime(l.x2 as number, l.xloc as string);
          const a = scale.x(t1);
          const b = scale.x(t2);
          const ay = scale.y(l.y1 as number);
          const by = scale.y(l.y2 as number);
          if (a == null || b == null || ay == null || by == null) continue;
          const extend = String(l.extend ?? "none");
          const [x1, y1, x2, y2] = extendToEdges(a, ay, b, by, scale.width, extend === "left" || extend === "both", extend === "right" || extend === "both");
          ctx.strokeStyle = pineColorToCss(l.color, "#e7ebf3");
          ctx.lineWidth = Number(l.width ?? 1);
          setLineDash(ctx, String(l.style ?? "solid"));
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        for (const label of labels) {
          const lb = label as Record<string, unknown>;
          const t = toTime(lb.x as number, lb.xloc as string);
          const px = scale.x(t);
          const py = scale.y(lb.y as number);
          if (px == null || py == null) continue;
          const text = String(lb.text ?? "");
          if (!text) continue;
          const style = String(lb.style ?? "label_down");
          const { bx, by, boxW, boxH, hasBox } = computeLabelBox(ctx, text, px, py, style);
          if (hasBox) {
            ctx.fillStyle = pineColorToCss(lb.color, "rgba(33,150,243,0.9)");
            ctx.beginPath();
            const r = 3;
            ctx.moveTo(bx + r, by);
            ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r);
            ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r);
            ctx.arcTo(bx, by + boxH, bx, by, r);
            ctx.arcTo(bx, by, bx + boxW, by, r);
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = pineColorToCss(lb.textColor, "#e7ebf3");
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text, bx + boxW / 2, by + boxH / 2);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
        }

        for (const plotSeries of plots) {
          if (plotSeries.points.length === 0) continue;
          ctx.strokeStyle = plotSeries.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let started = false;
          for (const p of plotSeries.points) {
            const px = scale.x(p.time);
            const py = scale.y(p.value);
            if (px == null || py == null) continue;
            if (!started) {
              ctx.moveTo(px, py);
              started = true;
            } else {
              ctx.lineTo(px, py);
            }
          }
          if (started) ctx.stroke();
        }
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, containerEl]);

  // Double-click a line/box/label an indicator drew to jump straight to
  // that indicator's settings, rather than needing to find it by name in
  // the Analysis hub's list. Only handled when no drawing tool is armed -
  // otherwise this would fight with placing a user drawing, which owns
  // clicks on this same pane (see DrawingLayer).
  useEffect(() => {
    function onDblClick(e: MouseEvent) {
      const tool = useUiStore.getState().activeToolId;
      if (DRAWING_KINDS[tool as DrawingType]) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx) return;

      const rect = containerEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);

      const list = resultsRef.current;
      for (let ri = list.length - 1; ri >= 0; ri--) {
        const result = list[ri];
        const bars = result.windowedBars;
        if (bars.length === 0) continue;
        const avgInterval = avgBarInterval(bars);
        const toTime = (xlocValue: number, xloc: string) =>
          xloc === "bar_time" ? xlocValue / 1000 : barIndexToTime(xlocValue, bars, avgInterval);
        const { lines, boxes, labels } = result.outputs;

        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i] as Record<string, unknown>;
          const a = scale.x(toTime(l.x1 as number, l.xloc as string));
          const b = scale.x(toTime(l.x2 as number, l.xloc as string));
          const ay = scale.y(l.y1 as number);
          const by = scale.y(l.y2 as number);
          if (a == null || b == null || ay == null || by == null) continue;
          const extend = String(l.extend ?? "none");
          const [x1, y1, x2, y2] = extendToEdges(a, ay, b, by, scale.width, extend === "left" || extend === "both", extend === "right" || extend === "both");
          if (distToSegment(x, y, x1, y1, x2, y2) <= HIT_PX) {
            openSettingsFor(result.indicator.id);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        for (let i = boxes.length - 1; i >= 0; i--) {
          const b = boxes[i] as Record<string, unknown>;
          const x0raw = scale.x(toTime(b.left as number, b.xloc as string));
          const x1raw = scale.x(toTime(b.right as number, b.xloc as string));
          const y0 = scale.y(b.top as number);
          const y1 = scale.y(b.bottom as number);
          if (x0raw == null || x1raw == null || y0 == null || y1 == null) continue;
          const extend = String(b.extend ?? "none");
          let x0 = Math.min(x0raw, x1raw);
          let x1 = Math.max(x0raw, x1raw);
          if (extend === "left" || extend === "both") x0 = 0;
          if (extend === "right" || extend === "both") x1 = scale.width;
          if (pointInRect(x, y, x0, y0, x1, y1, 3)) {
            openSettingsFor(result.indicator.id);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        for (let i = labels.length - 1; i >= 0; i--) {
          const lb = labels[i] as Record<string, unknown>;
          const px = scale.x(toTime(lb.x as number, lb.xloc as string));
          const py = scale.y(lb.y as number);
          if (px == null || py == null) continue;
          const text = String(lb.text ?? "");
          if (!text) continue;
          const { bx, by, boxW, boxH } = computeLabelBox(ctx, text, px, py, String(lb.style ?? "label_down"));
          if (pointInRect(x, y, bx, by, bx + boxW, by + boxH, 0)) {
            openSettingsFor(result.indicator.id);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }
    }

    function openSettingsFor(indicatorId: string) {
      useUiStore.getState().setPineEditTarget(indicatorId);
    }

    containerEl.addEventListener("dblclick", onDblClick, { capture: true });
    return () => containerEl.removeEventListener("dblclick", onDblClick, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerEl, chart, series]);

  // Right-click a recorded trade's profit/loss zone -> offer to remove it
  // from the Trades panel / pane-header stats / journal. Only boxes tagged
  // with a tradeId (see backtest.recordTrade in stdlib.ts) are eligible -
  // a right-click anywhere else on a Pine indicator's drawing is a no-op,
  // same as today.
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      const rect = containerEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);

      const list = resultsRef.current;
      for (let ri = list.length - 1; ri >= 0; ri--) {
        const bars = list[ri].windowedBars;
        if (bars.length === 0) continue;
        const avgInterval = avgBarInterval(bars);
        const toTime = (xlocValue: number, xloc: string) =>
          xloc === "bar_time" ? xlocValue / 1000 : barIndexToTime(xlocValue, bars, avgInterval);
        const { boxes } = list[ri].outputs;
        for (let i = boxes.length - 1; i >= 0; i--) {
          const b = boxes[i] as Record<string, unknown>;
          if (typeof b.tradeId !== "string") continue;
          const x0raw = scale.x(toTime(b.left as number, b.xloc as string));
          const x1raw = scale.x(toTime(b.right as number, b.xloc as string));
          const y0 = scale.y(b.top as number);
          const y1 = scale.y(b.bottom as number);
          if (x0raw == null || x1raw == null || y0 == null || y1 == null) continue;
          const x0 = Math.min(x0raw, x1raw);
          const x1 = Math.max(x0raw, x1raw);
          if (pointInRect(x, y, x0, y0, x1, y1, 3)) {
            e.preventDefault();
            setTradeMenu({ x: e.clientX, y: e.clientY, tradeId: b.tradeId });
            return;
          }
        }
      }
      setTradeMenu(null);
    }

    containerEl.addEventListener("contextmenu", onContextMenu);
    return () => containerEl.removeEventListener("contextmenu", onContextMenu);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerEl, chart, series]);

  useEffect(() => {
    if (!tradeMenu) return;
    function close() {
      setTradeMenu(null);
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [tradeMenu]);

  return (
    <>
      <canvas ref={canvasRef} className="pine-indicator-layer-canvas" />
      {tradeMenu && (
        <div
          className="pine-trade-menu"
          style={{ left: tradeMenu.x, top: tradeMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              usePineTradeOverridesStore.getState().remove(tradeMenu.tradeId);
              setTradeMenu(null);
            }}
          >
            Remove Trade
          </button>
        </div>
      )}
    </>
  );
}
