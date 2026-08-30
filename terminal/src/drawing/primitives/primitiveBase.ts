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
 * Shared ISeriesPrimitive lifecycle for every drawing tool migrated AFTER
 * Rectangle (see rectanglePrimitive.ts - that file stays a hand-written,
 * already-verified reference implementation and deliberately does NOT use
 * this base, so nothing here can regress it).
 *
 * Every tool built on this base supplies exactly two pure functions (a
 * DrawingPrimitiveSpec): `computeState` (DrawingObject + chart/series -> a
 * small plain draw-state object, or null to draw nothing) and `draw`
 * (draw-state -> canvas calls). Everything else - attach/detach,
 * subscribing to just this one object's own changes in drawingStore,
 * calling requestUpdate only when THAT object's reference actually
 * changes, and the paneView/renderer plumbing the library expects - is
 * identical across tools and lives here exactly once, instead of being
 * copy-pasted per tool the way rectanglePrimitive.ts's Phase-1 version had
 * it inline.
 */
export interface DrawingPrimitiveSpec<TState> {
  computeState(obj: DrawingObject, chart: IChartApi, series: ISeriesApi<"Candlestick">): TState | null;
  draw(target: CanvasRenderingTarget2D, state: TState): void;
}

class GenericPaneRenderer<TState> implements IPrimitivePaneRenderer {
  private _spec: DrawingPrimitiveSpec<TState>;
  private _state: TState | null;

  constructor(spec: DrawingPrimitiveSpec<TState>, state: TState | null) {
    this._spec = spec;
    this._state = state;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (this._state == null) return;
    this._spec.draw(target, this._state);
  }
}

class GenericPaneView<TState> implements IPrimitivePaneView {
  private _source: DrawingPrimitive<TState>;
  private _state: TState | null = null;

  constructor(source: DrawingPrimitive<TState>) {
    this._source = source;
  }

  update(): void {
    const obj = this._source.getObject();
    this._state = obj && !obj.hidden ? this._source.spec.computeState(obj, this._source.chart, this._source.series) : null;
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new GenericPaneRenderer(this._source.spec, this._state);
  }
}

export class DrawingPrimitive<TState> implements ISeriesPrimitive<Time> {
  readonly drawingId: string;
  readonly spec: DrawingPrimitiveSpec<TState>;
  private _paneKey: string;
  private _chart?: IChartApi;
  private _series?: ISeriesApi<"Candlestick">;
  private _unsubscribe?: () => void;
  private _paneView: GenericPaneView<TState>;

  constructor(paneKey: string, drawingId: string, spec: DrawingPrimitiveSpec<TState>) {
    this._paneKey = paneKey;
    this.drawingId = drawingId;
    this.spec = spec;
    this._paneView = new GenericPaneView(this);
  }

  getObject(): DrawingObject | undefined {
    return useDrawingStore.getState().getDrawings(this._paneKey).find((d) => d.id === this.drawingId);
  }

  get chart(): IChartApi {
    if (!this._chart) throw new Error("DrawingPrimitive used before attached()");
    return this._chart;
  }

  get series(): ISeriesApi<"Candlestick"> {
    if (!this._series) throw new Error("DrawingPrimitive used before attached()");
    return this._series;
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this._chart = chart as IChartApi;
    this._series = series as ISeriesApi<"Candlestick">;
    // Same selective-redraw contract as rectanglePrimitive.ts: only THIS
    // object's own store entry changing reference triggers a repaint -
    // never a timer, never an unrelated pane's or drawing's mutation.
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
