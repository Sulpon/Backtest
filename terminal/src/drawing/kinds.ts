import type { DrawingObject, DrawingPoint, DrawingStyle, DrawingType } from "./types";
import { DEFAULT_STYLE } from "./types";
import { distToSegment, pointInRect, pointInTriangle, distToPolyline, type PixelPoint } from "./geometry";
import type { ModifierKeyState } from "./interactionState";

export interface DrawScale {
  x(time: number): number | null;
  y(price: number): number | null;
  toPx(time: number, price: number): PixelPoint | null;
  /** Inverse of toPx - canvas-local pixel to chart data. Only needed by
   * kinds that compute geometry in pixel space (Shift constraints, corner
   * resize) and convert the result back; render/hitTest never need it. */
  fromPx(x: number, y: number): { time: number; price: number } | null;
  width: number;
  height: number;
}

/** A resize handle whose position is DERIVED from an object's stored
 * points rather than being one of them directly - e.g. rectangle's other
 * two corners and its four edge midpoints. `apply` always receives the
 * points frozen at drag-start (never the live/mutating points), so which
 * stored point supplies which side can't flip mid-gesture. `opposite` (set
 * only on the four corner handles) names the diagonally-opposite handle,
 * used as the fixed reference point for the Shift "keep it square"
 * constraint. */
export interface ResizeHandle {
  id: string;
  cursor: string;
  pixel: PixelPoint;
  opposite?: string;
  apply(startPoints: DrawingPoint[], data: { time: number; price: number }): DrawingPoint[];
}

export interface DrawingKind {
  type: DrawingType;
  label: string;
  pointCount: number;
  defaultStyle: DrawingStyle;
  render(ctx: CanvasRenderingContext2D, scale: DrawScale, obj: DrawingObject): void;
  hitTest(scale: DrawScale, obj: DrawingObject, x: number, y: number): boolean;
  handleIndices(obj: DrawingObject): number[];
  /** Override where a handle is drawn - default is the point's own pixel position.
   * Used by h-line/v-line, whose stored point has no meaningful x/y respectively. */
  handlePixel?(idx: number, obj: DrawingObject, scale: DrawScale): PixelPoint | null;
  /** Named resize handles beyond the raw point handles (rectangle's edges
   * and other two corners). Kinds without this only expose point handles. */
  resizeHandles?(obj: DrawingObject, scale: DrawScale): ResizeHandle[];
  /** Shift-constrained placement, used both while placing the last point of
   * a new object and while dragging an existing point handle. `anchor` is
   * the point(s) that stay fixed. Kinds without this simply have no Shift
   * behavior - Shift never breaks a tool that doesn't define it. */
  constrainPoint?(
    anchor: DrawingPoint[],
    free: { time: number; price: number },
    scale: DrawScale,
    modifiers: ModifierKeyState
  ): { time: number; price: number };
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const HIT_PX = 6;

/** Extends a segment's endpoints out to the canvas's left/right edges along
 * its own direction, in pixel space. Returns the ORIGINAL endpoints when
 * neither flag is set, so kinds using this are pixel-identical to before
 * for any drawing that doesn't opt into extend. */
function extendToEdges(
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

function drawArrowhead(ctx: CanvasRenderingContext2D, tip: PixelPoint, from: PixelPoint, color: string) {
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

/** Shift-angle-snap shared by any single-anchor point placement: keeps the
 * distance from `anchor` but rounds the direction to the nearest 45deg. */
function snapAngleFromAnchor(
  anchor: DrawingPoint,
  free: { time: number; price: number },
  scale: DrawScale,
  modifiers: ModifierKeyState
): { time: number; price: number } {
  if (!modifiers.shift) return free;
  const a = scale.toPx(anchor.time, anchor.price);
  const f = scale.toPx(free.time, free.price);
  if (!a || !f) return free;
  const dx = f.x - a.x;
  const dy = f.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return free;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const target = { x: a.x + dist * Math.cos(angle), y: a.y + dist * Math.sin(angle) };
  return scale.fromPx(target.x, target.y) ?? free;
}

const trendline: DrawingKind = {
  type: "trendline",
  label: "Trend Line",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const [p1, p2] = obj.points;
    const rawA = scale.toPx(p1.time, p1.price);
    const rawB = scale.toPx(p2.time, p2.price);
    if (!rawA || !rawB) return;
    const { a, b } = extendToEdges(rawA, rawB, scale.width, !!obj.props.extendLeft, !!obj.props.extendRight);
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (obj.props.arrowStart) drawArrowhead(ctx, rawA, rawB, obj.style.color);
    if (obj.props.arrowEnd) drawArrowhead(ctx, rawB, rawA, obj.style.color);
  },
  hitTest(scale, obj, x, y) {
    const [p1, p2] = obj.points;
    const rawA = scale.toPx(p1.time, p1.price);
    const rawB = scale.toPx(p2.time, p2.price);
    if (!rawA || !rawB) return false;
    const { a, b } = extendToEdges(rawA, rawB, scale.width, !!obj.props.extendLeft, !!obj.props.extendRight);
    return distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_PX;
  },
  handleIndices: () => [0, 1],
  constrainPoint: (anchor, free, scale, modifiers) => snapAngleFromAnchor(anchor[0], free, scale, modifiers),
};

const hline: DrawingKind = {
  type: "hline",
  label: "Horizontal Line",
  pointCount: 1,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const y = scale.y(obj.points[0].price);
    if (y == null) return;
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(scale.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = obj.style.color;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "right";
    ctx.fillText(obj.points[0].price.toFixed(5), scale.width - 6, y - 4);
    ctx.textAlign = "left";
  },
  hitTest(scale, obj, _x, y) {
    const py = scale.y(obj.points[0].price);
    if (py == null) return false;
    return Math.abs(y - py) <= HIT_PX;
  },
  handleIndices: () => [0],
  handlePixel(_idx, obj, scale) {
    const y = scale.y(obj.points[0].price);
    return y == null ? null : { x: scale.width / 2, y };
  },
};

const vline: DrawingKind = {
  type: "vline",
  label: "Vertical Line",
  pointCount: 1,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const x = scale.x(obj.points[0].time);
    if (x == null) return;
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, scale.height);
    ctx.stroke();
    ctx.setLineDash([]);
  },
  hitTest(scale, obj, x) {
    const px = scale.x(obj.points[0].time);
    if (px == null) return false;
    return Math.abs(x - px) <= HIT_PX;
  },
  handleIndices: () => [0],
  handlePixel(_idx, obj, scale) {
    const x = scale.x(obj.points[0].time);
    return x == null ? null : { x, y: scale.height / 2 };
  },
};

/** Extends a ray from `a` through `b` to whichever canvas edge lies beyond
 * `b` in that direction - never back past `a`. */
function rayEnd(a: PixelPoint, b: PixelPoint, width: number, height: number): PixelPoint {
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

const ray: DrawingKind = {
  type: "ray",
  label: "Ray",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return;
    const end = rayEnd(a, b, scale.width, scale.height);
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  },
  hitTest(scale, obj, x, y) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return false;
    const end = rayEnd(a, b, scale.width, scale.height);
    return distToSegment(x, y, a.x, a.y, end.x, end.y) <= HIT_PX;
  },
  handleIndices: () => [0, 1],
};

function rectBounds(scale: DrawScale, obj: DrawingObject) {
  const [p1, p2] = obj.points;
  const a = scale.toPx(p1.time, p1.price);
  const b = scale.toPx(p2.time, p2.price);
  if (!a || !b) return null;
  return { a, b, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
}

function rectResizeHandles(obj: DrawingObject, scale: DrawScale): ResizeHandle[] {
  const bounds = rectBounds(scale, obj);
  if (!bounds) return [];
  const { x0, x1, y0, y1 } = bounds;
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;

  function apply(wantLeft: boolean | null, wantTop: boolean | null) {
    return (startPoints: DrawingPoint[], data: { time: number; price: number }): DrawingPoint[] => {
      const [sp1, sp2] = startPoints;
      const leftIsP1 = sp1.time <= sp2.time;
      const topIsP1 = sp1.price >= sp2.price; // higher price renders higher on screen
      const next: DrawingPoint[] = [{ ...sp1 }, { ...sp2 }];
      if (wantLeft != null) {
        const i = (wantLeft ? leftIsP1 : !leftIsP1) ? 0 : 1;
        next[i] = { ...next[i], time: data.time };
      }
      if (wantTop != null) {
        const i = (wantTop ? topIsP1 : !topIsP1) ? 0 : 1;
        next[i] = { ...next[i], price: data.price };
      }
      return next;
    };
  }

  return [
    { id: "nw", cursor: "nwse-resize", pixel: { x: x0, y: y0 }, opposite: "se", apply: apply(true, true) },
    { id: "ne", cursor: "nesw-resize", pixel: { x: x1, y: y0 }, opposite: "sw", apply: apply(false, true) },
    { id: "se", cursor: "nwse-resize", pixel: { x: x1, y: y1 }, opposite: "nw", apply: apply(false, false) },
    { id: "sw", cursor: "nesw-resize", pixel: { x: x0, y: y1 }, opposite: "ne", apply: apply(true, false) },
    { id: "n", cursor: "ns-resize", pixel: { x: midX, y: y0 }, apply: apply(null, true) },
    { id: "s", cursor: "ns-resize", pixel: { x: midX, y: y1 }, apply: apply(null, false) },
    { id: "e", cursor: "ew-resize", pixel: { x: x1, y: midY }, apply: apply(false, null) },
    { id: "w", cursor: "ew-resize", pixel: { x: x0, y: midY }, apply: apply(true, null) },
  ];
}

const rectangle: DrawingKind = {
  type: "rectangle",
  label: "Rectangle",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return;
    const x0 = obj.props.extendLeft ? 0 : bounds.x0;
    const x1 = obj.props.extendRight ? scale.width : bounds.x1;
    const { y0, y1 } = bounds;
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.15;
    ctx.fillStyle = withAlpha(obj.style.color, opacity);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  },
  hitTest(scale, obj, x, y) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return false;
    const x0 = obj.props.extendLeft ? 0 : bounds.x0;
    const x1 = obj.props.extendRight ? scale.width : bounds.x1;
    return pointInRect(x, y, x0, bounds.y0, x1, bounds.y1, 4);
  },
  handleIndices: () => [0, 1],
  resizeHandles: rectResizeHandles,
  constrainPoint(anchor, free, scale, modifiers) {
    if (!modifiers.shift) return free;
    const a = scale.toPx(anchor[0].time, anchor[0].price);
    const f = scale.toPx(free.time, free.price);
    if (!a || !f) return free;
    const dx = f.x - a.x;
    const dy = f.y - a.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    const target = { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
    return scale.fromPx(target.x, target.y) ?? free;
  },
};

// Exported so the market-structure logger (src/marketStructure/) can log
// the exact same levels it renders, instead of duplicating this list and
// risking the two silently drifting apart.
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.71, 0.786, 1.0];

const fibretracement: DrawingKind = {
  type: "fibretracement",
  label: "Fib Retracement",
  pointCount: 2,
  defaultStyle: { color: "#d4a24e", lineWidth: 1 },
  render(ctx, scale, obj) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return;
    const hi = Math.max(p1.price, p2.price);
    const lo = Math.min(p1.price, p2.price);
    const range = hi - lo;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    ctx.fillStyle = "rgba(212,162,78,0.06)";
    ctx.fillRect(x0, Math.min(a.y, b.y), x1 - x0, Math.abs(a.y - b.y));
    FIB_LEVELS.forEach((f) => {
      const price = hi - f * range;
      const y = scale.y(price);
      if (y == null) return;
      const isOte = f === 0.71;
      ctx.strokeStyle = isOte ? "#d4a24e" : "rgba(150,160,180,0.55)";
      ctx.lineWidth = isOte ? 2 : 1;
      if (!isOte) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isOte ? "#d4a24e" : "rgba(150,160,180,0.8)";
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.fillText(`${(f * 100).toFixed(1)}%`, x1 + 4, y + 3);
    });
  },
  hitTest(scale, obj, x, y) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return false;
    return pointInRect(x, y, a.x, a.y, b.x, b.y, 4);
  },
  handleIndices: () => [0, 1],
};

function positionZones(obj: DrawingObject) {
  const [p1, p2] = obj.points;
  const entry = p1.price;
  const stop = p2.price;
  const rr = obj.meta?.rr ?? 2.45;
  const risk = Math.abs(entry - stop);
  const target = obj.type === "long" ? entry + rr * risk : entry - rr * risk;
  return { entry, stop, target, rr };
}

function positionKind(type: "long" | "short"): DrawingKind {
  return {
    type,
    label: type === "long" ? "Long Position" : "Short Position",
    pointCount: 2,
    defaultStyle: DEFAULT_STYLE,
    render(ctx, scale, obj) {
      const [p1, p2] = obj.points;
      const { entry, stop, target, rr } = positionZones(obj);
      const x0 = scale.x(Math.min(p1.time, p2.time));
      const x1 = scale.x(Math.max(p1.time, p2.time));
      const yEntry = scale.y(entry);
      const yStop = scale.y(stop);
      const yTarget = scale.y(target);
      if (x0 == null || x1 == null || yEntry == null || yStop == null || yTarget == null) return;

      ctx.fillStyle = "rgba(239,83,80,0.25)";
      ctx.fillRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yEntry - yStop));
      ctx.strokeStyle = "rgba(239,83,80,0.85)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yEntry - yStop));

      ctx.fillStyle = "rgba(38,166,154,0.25)";
      ctx.fillRect(x0, Math.min(yEntry, yTarget), x1 - x0, Math.abs(yEntry - yTarget));
      ctx.strokeStyle = "rgba(38,166,154,0.85)";
      ctx.strokeRect(x0, Math.min(yEntry, yTarget), x1 - x0, Math.abs(yEntry - yTarget));

      ctx.strokeStyle = obj.style.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, yEntry);
      ctx.lineTo(x1, yEntry);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = obj.style.color;
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillText(`${type === "long" ? "LONG" : "SHORT"} ${rr.toFixed(2)}R`, x0 + 4, Math.min(yEntry, yTarget) - 4);
    },
    hitTest(scale, obj, x, y) {
      const [p1, p2] = obj.points;
      const { entry, stop, target } = positionZones(obj);
      const top = Math.max(entry, stop, target);
      const bottom = Math.min(entry, stop, target);
      const x0 = scale.x(Math.min(p1.time, p2.time));
      const x1 = scale.x(Math.max(p1.time, p2.time));
      const yTop = scale.y(top);
      const yBot = scale.y(bottom);
      if (x0 == null || x1 == null || yTop == null || yBot == null) return false;
      return pointInRect(x, y, x0, yTop, x1, yBot, 4);
    },
    handleIndices: () => [0, 1],
  };
}

// Market-structure markers (see src/marketStructure/) - a 2-point line, same
// interaction as Trend Line, plus a text label centered above the
// midpoint. Color is per TYPE only (BOS vs CHoCH), matching smc.pine's own
// convention of one color per structure type regardless of direction -
// direction is unambiguous from the label text itself (the arrow), not
// from color, so there's no risk of a bull/bear color scheme clashing with
// a user's own chart theme or colorblindness.
function marketStructureKind(type: DrawingType, toolLabel: string, displayLabel: string, color: string): DrawingKind {
  return {
    type,
    label: toolLabel,
    pointCount: 2,
    defaultStyle: { color, lineWidth: 2 },
    render(ctx, scale, obj) {
      const [p1, p2] = obj.points;
      const a = scale.toPx(p1.time, p1.price);
      const b = scale.toPx(p2.time, p2.price);
      if (!a || !b) return;
      ctx.strokeStyle = obj.style.color;
      ctx.lineWidth = obj.style.lineWidth;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      ctx.fillStyle = obj.style.color;
      ctx.font = "bold 11px -apple-system, 'Segoe UI', Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(displayLabel, midX, midY - 8);
      ctx.textAlign = "left";
    },
    hitTest(scale, obj, x, y) {
      const [p1, p2] = obj.points;
      const a = scale.toPx(p1.time, p1.price);
      const b = scale.toPx(p2.time, p2.price);
      if (!a || !b) return false;
      return distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_PX;
    },
    handleIndices: () => [0, 1],
  };
}

// ============================================================================
// Phase 3: brand-new tools (no prior canvas-only history to port - each of
// these ships with BOTH this render()/hitTest() (used for the live
// placement preview and as the flag-off fallback) AND a matching
// ISeriesPrimitive under src/drawing/primitives/, following the exact
// pattern rectanglePrimitive.ts established in Phase 1. Reuses existing
// private helpers already in this file (withAlpha, extendToEdges,
// drawArrowhead, snapAngleFromAnchor, rectBounds, rectResizeHandles) rather
// than duplicating them, per "reuse existing... do not duplicate code".
// ============================================================================

const text: DrawingKind = {
  type: "text",
  label: "Text",
  pointCount: 1,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const p = scale.toPx(obj.points[0].time, obj.points[0].price);
    if (!p) return;
    const content = typeof obj.props.text === "string" ? obj.props.text : "";
    if (!content) return;
    const fontSize = typeof obj.props.fontSize === "number" ? obj.props.fontSize : 13;
    ctx.fillStyle = obj.style.color;
    ctx.font = `${fontSize}px -apple-system, 'Segoe UI', Arial, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(content, p.x, p.y);
    ctx.textBaseline = "alphabetic";
  },
  hitTest(scale, obj, x, y) {
    const p = scale.toPx(obj.points[0].time, obj.points[0].price);
    if (!p) return false;
    const content = typeof obj.props.text === "string" ? obj.props.text : "";
    const fontSize = typeof obj.props.fontSize === "number" ? obj.props.fontSize : 13;
    // No CanvasRenderingContext2D available in hitTest's signature to call
    // measureText() - an approximate average-glyph-width box is good enough
    // for click/selection purposes (same tradeoff PineIndicatorLayer's own
    // label hit-testing makes, just without that layer's real ctx access).
    const width = Math.max(content.length * fontSize * 0.6, fontSize);
    return pointInRect(x, y, p.x, p.y, p.x + width, p.y + fontSize * 1.4, 4);
  },
  handleIndices: () => [0],
};

const arrow: DrawingKind = {
  type: "arrow",
  label: "Arrow",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return;
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    drawArrowhead(ctx, b, a, obj.style.color);
  },
  hitTest(scale, obj, x, y) {
    const [p1, p2] = obj.points;
    const a = scale.toPx(p1.time, p1.price);
    const b = scale.toPx(p2.time, p2.price);
    if (!a || !b) return false;
    return distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_PX;
  },
  handleIndices: () => [0, 1],
  constrainPoint: (anchor, free, scale, modifiers) => snapAngleFromAnchor(anchor[0], free, scale, modifiers),
};

/** Circle is a center+edge model (point 0 = center, point 1 = a point on
 * the edge) rather than rectangle's two-corners model - radius is the
 * pixel distance between the two, recomputed from their own data
 * coordinates every render, so it stays anchored the same way every other
 * two-point tool does. */
function circleGeometry(scale: DrawScale, obj: DrawingObject): { c: PixelPoint; r: number } | null {
  const [p1, p2] = obj.points;
  const c = scale.toPx(p1.time, p1.price);
  const e = scale.toPx(p2.time, p2.price);
  if (!c || !e) return null;
  return { c, r: Math.hypot(e.x - c.x, e.y - c.y) };
}

const circle: DrawingKind = {
  type: "circle",
  label: "Circle",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const geo = circleGeometry(scale, obj);
    if (!geo) return;
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.1;
    ctx.beginPath();
    ctx.arc(geo.c.x, geo.c.y, geo.r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(obj.style.color, opacity);
    ctx.fill();
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.stroke();
  },
  hitTest(scale, obj, x, y) {
    const geo = circleGeometry(scale, obj);
    if (!geo) return false;
    return Math.hypot(x - geo.c.x, y - geo.c.y) <= geo.r + HIT_PX;
  },
  handleIndices: () => [0, 1],
};

const ellipse: DrawingKind = {
  type: "ellipse",
  label: "Ellipse",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return;
    const { x0, x1, y0, y1 } = bounds;
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.12;
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max((x1 - x0) / 2, 0.01), Math.max((y1 - y0) / 2, 0.01), 0, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(obj.style.color, opacity);
    ctx.fill();
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.stroke();
  },
  hitTest(scale, obj, x, y) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return false;
    const { x0, x1, y0, y1 } = bounds;
    const rx = Math.max((x1 - x0) / 2, 1);
    const ry = Math.max((y1 - y0) / 2, 1);
    const nx = (x - (x0 + x1) / 2) / rx;
    const ny = (y - (y0 + y1) / 2) / ry;
    return nx * nx + ny * ny <= 1.15; // small forgiveness band around the true edge
  },
  handleIndices: () => [0, 1],
  resizeHandles: rectResizeHandles,
  constrainPoint(anchor, free, scale, modifiers) {
    if (!modifiers.shift) return free; // Shift = perfect circle (square bounding box), same math as rectangle's own Shift constraint
    const a = scale.toPx(anchor[0].time, anchor[0].price);
    const f = scale.toPx(free.time, free.price);
    if (!a || !f) return free;
    const dx = f.x - a.x;
    const dy = f.y - a.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    const target = { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
    return scale.fromPx(target.x, target.y) ?? free;
  },
};

const triangle: DrawingKind = {
  type: "triangle",
  label: "Triangle",
  pointCount: 3,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    // A 3-point tool's live PREVIEW object can have only 2 points (one
    // corner placed, one still following the cursor) - hitTest never sees
    // this (only ever called against a finished, already-3-point stored
    // object), but render() must degrade gracefully to a plain line so
    // placement has visible feedback before the 3rd click.
    const pts = obj.points.map((p) => scale.toPx(p.time, p.price)).filter((p): p is PixelPoint => p != null);
    if (pts.length < 2) return;
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      return;
    }
    const [a, b, c] = pts;
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.12;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.fillStyle = withAlpha(obj.style.color, opacity);
    ctx.fill();
    ctx.stroke();
  },
  hitTest(scale, obj, x, y) {
    const pts = obj.points.map((p) => scale.toPx(p.time, p.price)).filter((p): p is PixelPoint => p != null);
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    if (pointInTriangle(x, y, a.x, a.y, b.x, b.y, c.x, c.y)) return true;
    return (
      distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_PX ||
      distToSegment(x, y, b.x, b.y, c.x, c.y) <= HIT_PX ||
      distToSegment(x, y, c.x, c.y, a.x, a.y) <= HIT_PX
    );
  },
  handleIndices: () => [0, 1, 2],
};

/** Shared by parallelchannel and fibchannel: point 0/1 define the
 * baseline, point 2 (optional - absent during the 2-point placement
 * preview) defines the channel's perpendicular offset. `hasOffset` is
 * false only during that in-progress preview; every stored (finished)
 * object always has all 3 points, so hitTest never needs to check it. */
interface ChannelGeometry {
  a: PixelPoint;
  b: PixelPoint;
  a2: PixelPoint;
  b2: PixelPoint;
  hasOffset: boolean;
}

function channelGeometry(scale: DrawScale, obj: DrawingObject): ChannelGeometry | null {
  const [p0, p1, p2] = obj.points;
  const a = scale.toPx(p0.time, p0.price);
  const b = scale.toPx(p1.time, p1.price);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  let offset = 0;
  let hasOffset = false;
  if (p2) {
    const c = scale.toPx(p2.time, p2.price);
    if (c) {
      offset = (c.x - a.x) * nx + (c.y - a.y) * ny;
      hasOffset = true;
    }
  }
  return { a, b, a2: { x: a.x + nx * offset, y: a.y + ny * offset }, b2: { x: b.x + nx * offset, y: b.y + ny * offset }, hasOffset };
}

const parallelchannel: DrawingKind = {
  type: "parallelchannel",
  label: "Parallel Channel",
  pointCount: 3,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const geo = channelGeometry(scale, obj);
    if (!geo) return;
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    if (geo.hasOffset) {
      const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.1;
      ctx.beginPath();
      ctx.moveTo(geo.a.x, geo.a.y);
      ctx.lineTo(geo.b.x, geo.b.y);
      ctx.lineTo(geo.b2.x, geo.b2.y);
      ctx.lineTo(geo.a2.x, geo.a2.y);
      ctx.closePath();
      ctx.fillStyle = withAlpha(obj.style.color, opacity);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(geo.a.x, geo.a.y);
    ctx.lineTo(geo.b.x, geo.b.y);
    ctx.stroke();
    if (geo.hasOffset) {
      ctx.beginPath();
      ctx.moveTo(geo.a2.x, geo.a2.y);
      ctx.lineTo(geo.b2.x, geo.b2.y);
      ctx.stroke();
    }
  },
  hitTest(scale, obj, x, y) {
    const geo = channelGeometry(scale, obj);
    if (!geo) return false;
    return distToSegment(x, y, geo.a.x, geo.a.y, geo.b.x, geo.b.y) <= HIT_PX || distToSegment(x, y, geo.a2.x, geo.a2.y, geo.b2.x, geo.b2.y) <= HIT_PX;
  },
  handleIndices: () => [0, 1, 2],
};

const fibchannel: DrawingKind = {
  type: "fibchannel",
  label: "Fib Channel",
  pointCount: 3,
  defaultStyle: { color: "#d4a24e", lineWidth: 1 },
  render(ctx, scale, obj) {
    const geo = channelGeometry(scale, obj);
    if (!geo) return;
    if (!geo.hasOffset) {
      ctx.strokeStyle = obj.style.color;
      ctx.lineWidth = obj.style.lineWidth;
      ctx.beginPath();
      ctx.moveTo(geo.a.x, geo.a.y);
      ctx.lineTo(geo.b.x, geo.b.y);
      ctx.stroke();
      return;
    }
    // Reuses FIB_LEVELS (the same 0..1 ratios fibretracement uses) as the
    // channel's interpolation fractions between the baseline (0) and the
    // offset line (1) - one shared level list instead of a second constant.
    FIB_LEVELS.forEach((f) => {
      const isEdge = f === 0 || f === 1;
      const p1 = { x: geo.a.x + (geo.a2.x - geo.a.x) * f, y: geo.a.y + (geo.a2.y - geo.a.y) * f };
      const p2 = { x: geo.b.x + (geo.b2.x - geo.b.x) * f, y: geo.b.y + (geo.b2.y - geo.b.y) * f };
      ctx.strokeStyle = isEdge ? obj.style.color : "rgba(150,160,180,0.55)";
      ctx.lineWidth = isEdge ? obj.style.lineWidth : 1;
      if (!isEdge) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  },
  hitTest(scale, obj, x, y) {
    const geo = channelGeometry(scale, obj);
    if (!geo) return false;
    return distToSegment(x, y, geo.a.x, geo.a.y, geo.b.x, geo.b.y) <= HIT_PX || distToSegment(x, y, geo.a2.x, geo.a2.y, geo.b2.x, geo.b2.y) <= HIT_PX;
  },
  handleIndices: () => [0, 1, 2],
};

// Exported for the same reason FIB_LEVELS is - one shared source of truth
// for these ratios rather than a second copy anywhere that needs them.
export const FIB_EXTENSION_LEVELS = [0, 0.618, 1.0, 1.272, 1.618, 2.0, 2.618];

function fibExtensionGeometry(scale: DrawScale, obj: DrawingObject) {
  const pts = obj.points.map((p) => scale.toPx(p.time, p.price));
  if (pts.length < 3 || pts.some((p) => !p)) return null;
  const [pA, pB, pC] = obj.points;
  const [a, b, c] = pts as PixelPoint[];
  const range = pB.price - pA.price; // signed - direction of the A->B swing
  const x0 = c.x;
  const x1 = c.x + (b.x - a.x); // project the same horizontal span forward from C
  return { basePrice: pC.price, range, x0, x1 };
}

const fibextension: DrawingKind = {
  type: "fibextension",
  label: "Fib Extension",
  pointCount: 3,
  defaultStyle: { color: "#d4a24e", lineWidth: 1 },
  render(ctx, scale, obj) {
    const geo = fibExtensionGeometry(scale, obj);
    if (!geo) {
      // 2-point preview (A, B placed - C still following the cursor): just
      // show the swing baseline, same degrade-gracefully approach triangle
      // and the channel tools use.
      const pts = obj.points.map((p) => scale.toPx(p.time, p.price)).filter((p): p is PixelPoint => p != null);
      if (pts.length < 2) return;
      ctx.strokeStyle = obj.style.color;
      ctx.lineWidth = obj.style.lineWidth;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      return;
    }
    const x0 = Math.min(geo.x0, geo.x1);
    const x1 = Math.max(geo.x0, geo.x1);
    FIB_EXTENSION_LEVELS.forEach((f) => {
      const price = geo.basePrice + f * geo.range;
      const y = scale.y(price);
      if (y == null) return;
      const isKey = f === 1.0 || f === 1.618;
      ctx.strokeStyle = isKey ? "#d4a24e" : "rgba(150,160,180,0.55)";
      ctx.lineWidth = isKey ? 2 : 1;
      if (!isKey) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isKey ? "#d4a24e" : "rgba(150,160,180,0.8)";
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.fillText(`${(f * 100).toFixed(1)}%`, x1 + 4, y + 3);
    });
  },
  hitTest(scale, obj, x, y) {
    const geo = fibExtensionGeometry(scale, obj);
    if (!geo) return false;
    const x0 = Math.min(geo.x0, geo.x1);
    const x1 = Math.max(geo.x0, geo.x1);
    const prices = FIB_EXTENSION_LEVELS.map((f) => geo.basePrice + f * geo.range);
    const ys = prices.map((p) => scale.y(p)).filter((v): v is number => v != null);
    if (ys.length === 0) return false;
    return pointInRect(x, y, x0, Math.min(...ys), x1, Math.max(...ys), 4);
  },
  handleIndices: () => [0, 1, 2],
};

const pricerange: DrawingKind = {
  type: "pricerange",
  label: "Price Range",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return;
    const [p1, p2] = obj.points;
    const { x0, x1, y0, y1 } = bounds;
    const up = p2.price >= p1.price;
    const baseColor = up ? "#26a69a" : "#ef5350";
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.14;
    ctx.fillStyle = withAlpha(baseColor, opacity);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = baseColor;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const delta = p2.price - p1.price;
    const pct = p1.price !== 0 ? (delta / p1.price) * 100 : 0;
    ctx.fillStyle = baseColor;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${delta >= 0 ? "+" : ""}${delta.toFixed(5)}  (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`, (x0 + x1) / 2, y0 - 6);
    ctx.textAlign = "left";
  },
  hitTest(scale, obj, x, y) {
    const bounds = rectBounds(scale, obj);
    if (!bounds) return false;
    return pointInRect(x, y, bounds.x0, bounds.y0, bounds.x1, bounds.y1, 4);
  },
  handleIndices: () => [0, 1],
  resizeHandles: rectResizeHandles,
};

const daterange: DrawingKind = {
  type: "daterange",
  label: "Date Range",
  pointCount: 2,
  defaultStyle: DEFAULT_STYLE,
  render(ctx, scale, obj) {
    const [p1, p2] = obj.points;
    const x0raw = scale.x(p1.time);
    const x1raw = scale.x(p2.time);
    if (x0raw == null || x1raw == null) return;
    const x0 = Math.min(x0raw, x1raw);
    const x1 = Math.max(x0raw, x1raw);
    const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.08;
    ctx.fillStyle = withAlpha(obj.style.color, opacity);
    ctx.fillRect(x0, 0, x1 - x0, scale.height);
    ctx.strokeStyle = obj.style.color;
    ctx.lineWidth = obj.style.lineWidth;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, scale.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, scale.height);
    ctx.stroke();
    ctx.setLineDash([]);
    const seconds = Math.abs(p2.time - p1.time);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const label = days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
    ctx.fillStyle = obj.style.color;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, (x0 + x1) / 2, 14);
    ctx.textAlign = "left";
  },
  hitTest(scale, obj, x, _y) {
    const [p1, p2] = obj.points;
    const x0raw = scale.x(p1.time);
    const x1raw = scale.x(p2.time);
    if (x0raw == null || x1raw == null) return false;
    const x0 = Math.min(x0raw, x1raw);
    const x1 = Math.max(x0raw, x1raw);
    return x >= x0 - 4 && x <= x1 + 4;
  },
  handleIndices: () => [0, 1],
  handlePixel(idx, obj, scale) {
    const x = scale.x(obj.points[idx].time);
    return x == null ? null : { x, y: scale.height / 2 };
  },
};

/** Shared by brush/highlighter - the two freehand tools. `pointCount` is
 * Infinity as a marker value: DrawingLayer never reaches its normal
 * click-N-times completion check (`points.length >= kind.pointCount`) for
 * these two - they're placed through a dedicated
 * mousedown/mousemove-drag/mouseup path instead (see DrawingLayer.tsx's
 * freehand branch), so this value is never actually compared against
 * anything at runtime; it exists so `pointCount` stays a required, always-
 * meaningful field on every DrawingKind rather than becoming optional just
 * for these two. No resizeHandles/constrainPoint and an empty
 * handleIndices - a freehand stroke is moved as a whole (already fully
 * generic in DrawingLayer's drag handling for any points-array length),
 * never resized or per-point-dragged. */
function freehandKind(type: "brush" | "highlighter", label: string, defaultStyle: DrawingStyle, alpha: number): DrawingKind {
  return {
    type,
    label,
    pointCount: Number.POSITIVE_INFINITY,
    defaultStyle,
    render(ctx, scale, obj) {
      const pts = obj.points.map((p) => scale.toPx(p.time, p.price)).filter((p): p is PixelPoint => p != null);
      if (pts.length < 2) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = obj.style.color;
      ctx.lineWidth = obj.style.lineWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    },
    hitTest(scale, obj, x, y) {
      const pts = obj.points.map((p) => scale.toPx(p.time, p.price)).filter((p): p is PixelPoint => p != null);
      return distToPolyline(x, y, pts) <= HIT_PX + obj.style.lineWidth;
    },
    handleIndices: () => [],
  };
}

export const DRAWING_KINDS: Record<DrawingType, DrawingKind> = {
  trendline,
  hline,
  vline,
  ray,
  rectangle,
  fibretracement,
  long: positionKind("long"),
  short: positionKind("short"),
  bosbull: marketStructureKind("bosbull", "Bullish BOS", "BOS ↑", "#42a5f5"),
  bosbear: marketStructureKind("bosbear", "Bearish BOS", "BOS ↓", "#42a5f5"),
  chochbull: marketStructureKind("chochbull", "Bullish CHoCH", "CHoCH ↑", "#e0a64c"),
  chochbear: marketStructureKind("chochbear", "Bearish CHoCH", "CHoCH ↓", "#e0a64c"),
  text,
  arrow,
  circle,
  ellipse,
  triangle,
  parallelchannel,
  fibextension,
  fibchannel,
  pricerange,
  daterange,
  brush: freehandKind("brush", "Brush", DEFAULT_STYLE, 1),
  highlighter: freehandKind("highlighter", "Highlighter", { color: "#ffd54f", lineWidth: 3 }, 0.35),
};

export const HANDLE_RADIUS = 4;
export const SELECT_COLOR = "#ffe066";
