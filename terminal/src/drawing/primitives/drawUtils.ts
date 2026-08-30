import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

/**
 * Pure pixel-geometry helpers duplicated from kinds.ts's private
 * extendToEdges/rayEnd/drawArrowhead/withAlpha (they aren't exported there,
 * and are intentionally NOT imported here even though they could be -
 * keeping every new primitive file self-contained means a future edit to
 * kinds.ts's old renderer can't silently change a primitive's output, and
 * vice versa. Each function below is byte-for-byte the same formula as its
 * kinds.ts counterpart - see rectanglePrimitive.test.ts-style regression
 * tests for the parity proof.
 */

export interface PixelPoint {
  x: number;
  y: number;
}

/** Same alpha-blend formula as kinds.ts's private `withAlpha` and
 * rectanglePrimitive.ts's own copy (Phase 1 predates this shared file) -
 * duplicated here too for the same self-containment reason as the rest of
 * this module. Phase 3's shape tools (circle/ellipse/triangle/channels/
 * price range/date range) all import this ONE copy rather than each
 * duplicating it again. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function toPixel(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  point: { time: number; price: number }
): PixelPoint | null {
  const x = chart.timeScale().timeToCoordinate(point.time as Time);
  const y = series.priceToCoordinate(point.price);
  if (x == null || y == null) return null;
  return { x, y };
}

/** Extends a segment's endpoints out to the canvas's left/right edges along
 * its own direction, in pixel space. Returns the ORIGINAL endpoints when
 * neither flag is set. */
export function extendToEdges(
  a: PixelPoint,
  b: PixelPoint,
  width: number,
  extendLeft: boolean,
  extendRight: boolean
): { a: PixelPoint; b: PixelPoint } {
  if (!extendLeft && !extendRight) return { a, b };
  const dx = b.x - a.x;
  if (dx === 0) return { a, b };
  const dy = b.y - a.y;
  const leftIsA = a.x <= b.x;
  let pa = a;
  let pb = b;
  if (extendLeft) {
    const targetX = leftIsA ? 0 : width;
    const t = (targetX - a.x) / dx;
    const pt = { x: targetX, y: a.y + t * dy };
    if (leftIsA) pa = pt;
    else pb = pt;
  }
  if (extendRight) {
    const targetX = leftIsA ? width : 0;
    const t = (targetX - a.x) / dx;
    const pt = { x: targetX, y: a.y + t * dy };
    if (leftIsA) pb = pt;
    else pa = pt;
  }
  return { a: pa, b: pb };
}

/** Extends a ray from `a` through `b` to whichever canvas edge lies beyond
 * `b` in that direction - never back past `a`. */
export function rayEnd(a: PixelPoint, b: PixelPoint, width: number, height: number): PixelPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return b;
  const candidates: number[] = [];
  if (dx > 0) candidates.push((width - a.x) / dx);
  else if (dx < 0) candidates.push((0 - a.x) / dx);
  if (dy > 0) candidates.push((height - a.y) / dy);
  else if (dy < 0) candidates.push((0 - a.y) / dy);
  const positive = candidates.filter((v) => v > 0);
  const t = positive.length ? Math.min(...positive) : 0;
  return t > 0 && isFinite(t) ? { x: a.x + t * dx, y: a.y + t * dy } : b;
}

export function drawArrowhead(ctx: CanvasRenderingContext2D, tip: PixelPoint, from: PixelPoint, color: string): void {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const size = 9;
  const spread = 0.45;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(angle - spread), tip.y - size * Math.sin(angle - spread));
  ctx.lineTo(tip.x - size * Math.cos(angle + spread), tip.y - size * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
