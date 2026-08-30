import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { DrawingObject } from "../types";
import { useDrawingStore } from "../drawingStore";

/**
 * Rectangle ISeriesPrimitive (Lightweight Charts v5 plugin architecture) -
 * the Phase 1 proof-of-concept for migrating drawing tools off the
 * DrawingLayer canvas+rAF renderer (see kinds.ts's `rectangle` DrawingKind,
 * which this intentionally mirrors pixel-for-pixel and remains the
 * production fallback behind featureFlag.ts).
 *
 * One instance per rectangle DrawingObject (matches the official
 * plugin-examples/rectangle-drawing-tool pattern: attach on create, detach
 * on delete). It does NOT own the object's data - it reads the live
 * DrawingObject out of drawingStore by (paneKey, drawingId) on every
 * update() and repaints only when that specific object's reference in the
 * store actually changes (drag, resize, style edit, hide/show, undo/redo -
 * all of which already write into drawingStore, so no new write path is
 * introduced anywhere). Chart-native causes of a redraw (pan, zoom, resize)
 * are handled entirely by the library itself calling updateAllViews() as
 * part of its own repaint - this primitive never schedules its own
 * animation frame.
 */

interface RectCoords {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Pure, independently testable: given the two stored points already
 * converted to pixel coordinates plus the extend-left/right props, returns
 * the normalized [x0,x1] x [y0,y1] box - exactly the same normalization
 * kinds.ts's private `rectBounds`/render() do (min/max the two corners,
 * then optionally stretch one edge to the canvas edge). Kept separate from
 * the renderer so the regression test can assert on numbers without a real
 * CanvasRenderingContext2D. */
export function computeRectCoords(
  p1: { x: number | null; y: number | null },
  p2: { x: number | null; y: number | null },
  mediaWidth: number,
  extendLeft: boolean,
  extendRight: boolean
): RectCoords | null {
  if (p1.x == null || p1.y == null || p2.x == null || p2.y == null) return null;
  const rawX0 = Math.min(p1.x, p2.x);
  const rawX1 = Math.max(p1.x, p2.x);
  return {
    x0: extendLeft ? 0 : rawX0,
    x1: extendRight ? mediaWidth : rawX1,
    y0: Math.min(p1.y, p2.y),
    y1: Math.max(p1.y, p2.y),
  };
}

/** Same alpha-blend helper as kinds.ts's private `withAlpha` - duplicated
 * (not exported/imported) so this primitive has zero coupling to the old
 * renderer's internals and can't be broken by a future kinds.ts edit. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

interface RectDrawState {
  p1: { x: number | null; y: number | null };
  p2: { x: number | null; y: number | null };
  color: string;
  lineWidth: number;
  extendLeft: boolean;
  extendRight: boolean;
  fillOpacity: number;
}

class RectanglePaneRenderer implements IPrimitivePaneRenderer {
  private _state: RectDrawState | null;

  constructor(state: RectDrawState | null) {
    this._state = state;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const state = this._state;
    if (!state) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const box = computeRectCoords(state.p1, state.p2, mediaSize.width, state.extendLeft, state.extendRight);
      if (!box) return;
      const { x0, x1, y0, y1 } = box;
      context.fillStyle = withAlpha(state.color, state.fillOpacity);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
      context.strokeStyle = state.color;
      context.lineWidth = state.lineWidth;
      context.strokeRect(x0, y0, x1 - x0, y1 - y0);
    });
  }
}

class RectanglePaneView implements IPrimitivePaneView {
  private _source: RectanglePrimitive;
  private _state: RectDrawState | null = null;

  constructor(source: RectanglePrimitive) {
    this._source = source;
  }

  update(): void {
    const obj = this._source.getObject();
    if (!obj || obj.hidden || obj.points.length < 2) {
      this._state = null;
      return;
    }
    const [pt1, pt2] = obj.points;
    const series = this._source.series;
    const timeScale = this._source.chart.timeScale();
    this._state = {
      p1: { x: timeScale.timeToCoordinate(pt1.time as Time), y: series.priceToCoordinate(pt1.price) },
      p2: { x: timeScale.timeToCoordinate(pt2.time as Time), y: series.priceToCoordinate(pt2.price) },
      color: obj.style.color,
      lineWidth: obj.style.lineWidth,
      extendLeft: !!obj.props.extendLeft,
      extendRight: !!obj.props.extendRight,
      fillOpacity: typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.15,
    };
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new RectanglePaneRenderer(this._state);
  }
}

export class RectanglePrimitive implements ISeriesPrimitive<Time> {
  readonly drawingId: string;
  private _paneKey: string;
  private _chart?: IChartApi;
  private _series?: ISeriesApi<"Candlestick">;
  private _unsubscribe?: () => void;
  private _paneView: RectanglePaneView;

  constructor(paneKey: string, drawingId: string) {
    this._paneKey = paneKey;
    this.drawingId = drawingId;
    this._paneView = new RectanglePaneView(this);
  }

  getObject(): DrawingObject | undefined {
    return useDrawingStore.getState().getDrawings(this._paneKey).find((d) => d.id === this.drawingId);
  }

  get chart(): IChartApi {
    if (!this._chart) throw new Error("RectanglePrimitive used before attached()");
    return this._chart;
  }

  get series(): ISeriesApi<"Candlestick"> {
    if (!this._series) throw new Error("RectanglePrimitive used before attached()");
    return this._series;
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this._chart = chart as IChartApi;
    this._series = series as ISeriesApi<"Candlestick">;
    // Redraw only when THIS object's entry in the store actually changes
    // reference (drag/resize/style/hide/undo-redo all replace it via
    // drawingStore's immutable updates) - never on an unrelated pane's or
    // unrelated drawing's mutation, and never on a timer.
    this._unsubscribe = useDrawingStore.subscribe((state, prevState) => {
      const cur = state.byPane[this._paneKey]?.find((d) => d.id === this.drawingId);
      const prev = prevState.byPane[this._paneKey]?.find((d) => d.id === this.drawingId);
      if (cur !== prev) requestUpdate();
    });
    requestUpdate();
  }

  detached(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._chart = undefined;
    this._series = undefined;
  }

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }
}
