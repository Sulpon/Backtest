// A deterministic, Telegram/mobile-friendly output size regardless of how
// large the actual chart pane happens to be on screen at capture time (see
// the original spec's "prefer a deterministic snapshot size/aspect ratio").
const SNAPSHOT_WIDTH = 1200;
const SNAPSHOT_HEIGHT = 675; // 16:9

/**
 * Composites the chart's own screenshot canvas with the Pine indicator
 * overlay canvas (if present), then scales the result into a fixed output
 * size.
 *
 * Why compositing is needed at all: candles, BOS/CHoCH lines, FVG boxes,
 * order blocks, liquidity, and swing markers are all real lightweight-
 * charts series/markers (see ChartPane.tsx), so chart.takeScreenshot()
 * already captures them natively - no second renderer needed for those.
 * A Pine indicator's own structure, however, draws to a SEPARATE <canvas>
 * layered on top of the chart (see PineIndicatorLayer.tsx) precisely
 * because it needs custom shapes lightweight-charts' own series types
 * can't express - takeScreenshot() alone would miss it entirely.
 *
 * "contain" scaling (not stretch/crop) preserves the chart's real aspect
 * ratio, letterboxing with the platform's own dark panel background rather
 * than distorting candles or cutting off price levels.
 *
 * Manual drawings (DrawingLayer's own separate canvas) are deliberately
 * NOT composited in - those are personal scratch annotations, not part of
 * the platform's indicator/SMC analysis a trade-review snapshot is meant
 * to show (see the original spec's reference image, which has none).
 */
export function compositeSnapshot(
  chartCanvas: HTMLCanvasElement,
  pineCanvas: HTMLCanvasElement | null,
  annotationCanvas: HTMLCanvasElement | null,
  backgroundColor: string
): string {
  const source = document.createElement("canvas");
  source.width = chartCanvas.width;
  source.height = chartCanvas.height;
  const sctx = source.getContext("2d");
  if (!sctx) throw new Error("2D canvas context unavailable");
  sctx.drawImage(chartCanvas, 0, 0);
  if (pineCanvas && pineCanvas.width > 0 && pineCanvas.height > 0) {
    sctx.drawImage(pineCanvas, 0, 0, source.width, source.height);
  }
  if (annotationCanvas && annotationCanvas.width > 0 && annotationCanvas.height > 0) {
    sctx.drawImage(annotationCanvas, 0, 0, source.width, source.height);
  }

  const out = document.createElement("canvas");
  out.width = SNAPSHOT_WIDTH;
  out.height = SNAPSHOT_HEIGHT;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, out.width, out.height);

  const scale = Math.min(out.width / source.width, out.height / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  const x = (out.width - w) / 2;
  const y = (out.height - h) / 2;
  ctx.drawImage(source, x, y, w, h);

  return out.toDataURL("image/png");
}

export interface ReviewZoneAnnotation {
  leftPx: number;
  rightPx: number;
  entryPx: number;
  slPx: number;
  tpPx: number;
  setupLabel: "BOS" | "CHoCH" | null;
}

/**
 * Draws the reviewed trade's own risk/reward zone, "Fib 1/0.71/0" level
 * labels, and a centered BOS/CHoCH label onto a fresh canvas the same
 * device-pixel size as the chart's own screenshot canvas, for
 * compositeSnapshot to layer on top.
 *
 * This exists as an EXPLICIT drawing pass (not a native lightweight-charts
 * series, and not smc.pine's own canvas output) because both of those
 * depend on the native chart's auto-scaled price range, which only fits
 * the currently-VISIBLE CANDLES - a structural level referencing an older
 * swing can fall outside that range and land off-screen (confirmed: this
 * is exactly why an earlier version of this feature's Pine-drawn
 * BOS/CHoCH lines sometimes failed to appear in a snapshot at all).
 * Computing pixel positions once via the chart's own timeToCoordinate/
 * priceToCoordinate (see ChartPane.tsx's takeSnapshot) and drawing them
 * directly sidesteps that entirely - this canvas is guaranteed to show
 * exactly the zone/levels it was asked to, regardless of what the
 * candles' own price range happens to be.
 *
 * All pixel inputs are CSS/logical pixels (matching timeToCoordinate/
 * priceToCoordinate's own units) - `dpr` and setTransform handle the
 * device-pixel scaling internally, the same technique PineIndicatorLayer
 * already uses for its own canvas.
 */
export function drawTradeAnnotations(widthPx: number, heightPx: number, dpr: number, a: ReviewZoneAnnotation): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(widthPx * dpr));
  canvas.height = Math.max(1, Math.round(heightPx * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const left = Math.min(a.leftPx, a.rightPx);
  const right = Math.max(a.leftPx, a.rightPx);
  const width = Math.max(right - left, 2);

  // Red zone: entry -> SL.
  ctx.fillStyle = "rgba(239,83,80,0.30)";
  ctx.fillRect(left, Math.min(a.entryPx, a.slPx), width, Math.abs(a.slPx - a.entryPx));
  ctx.strokeStyle = "rgba(239,83,80,0.9)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, Math.min(a.entryPx, a.slPx), width, Math.abs(a.slPx - a.entryPx));

  // Green zone: entry -> TP.
  ctx.fillStyle = "rgba(38,166,154,0.30)";
  ctx.fillRect(left, Math.min(a.entryPx, a.tpPx), width, Math.abs(a.tpPx - a.entryPx));
  ctx.strokeStyle = "rgba(38,166,154,0.9)";
  ctx.strokeRect(left, Math.min(a.entryPx, a.tpPx), width, Math.abs(a.tpPx - a.entryPx));

  ctx.font = "11px -apple-system, 'Segoe UI', Arial, sans-serif";
  ctx.textBaseline = "middle";

  function drawLevelLabel(text: string, y: number, color: string) {
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = ` ${text} `;
    const labelWidth = ctx.measureText(label).width;
    const boxX = Math.min(right + 4, Math.max(0, widthPx - labelWidth - 12));
    ctx.fillStyle = "rgba(16,20,27,0.85)";
    ctx.fillRect(boxX, y - 8, labelWidth + 4, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, boxX + 2, y);
  }
  drawLevelLabel("Fib 1 · SL", a.slPx, "#ef5350");
  drawLevelLabel("Fib 0.71 · Entry", a.entryPx, "#d0d4dc");
  drawLevelLabel("Fib 0 · TP", a.tpPx, "#26a69a");

  if (a.setupLabel) {
    const centerX = (left + right) / 2;
    const topY = Math.min(a.entryPx, a.slPx, a.tpPx) - 14;
    ctx.textAlign = "center";
    ctx.font = "bold 13px -apple-system, 'Segoe UI', Arial, sans-serif";
    ctx.fillStyle = a.setupLabel === "CHoCH" ? "#e0a64c" : "#42a5f5";
    ctx.fillText(a.setupLabel, centerX, topY);
    ctx.textAlign = "left";
  }

  return canvas;
}
