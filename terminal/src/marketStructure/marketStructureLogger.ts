import { useDrawingStore } from "../drawing/drawingStore";
import type { DrawingObject, DrawingPoint, DrawingType } from "../drawing/types";
import { FIB_LEVELS } from "../drawing/kinds";
import { dataLayer } from "../data/DataLayer";
import type { CandleBar, Timeframe } from "../data/types";
import { nearestIndexByTime } from "../lib/bars";
import { measureStructure } from "./marketStructureMeasure";
import { useMarketStructureStore, marketStructureSessionId } from "./marketStructureStore";
import type { FibonacciEvent, MarketStructureDirection, MarketStructureEvent, MarketStructureKind, MarketStructureRevision } from "./types";

/**
 * The independent observer that turns bosbull/bosbear/chochbull/chochbear
 * (and fibretracement) DrawingObjects into logged dataset records. This
 * file is the ONLY thing that touches useMarketStructureStore's write
 * actions - drawingStore, DrawingLayer, DrawingContextMenu etc. are never
 * modified or imported-into; they stay exactly as they were, and this
 * layer only ever READS useDrawingStore via subscribe(). Nothing here can
 * change what gets drawn, only what gets recorded about it.
 */

const MS_TYPES = new Set<DrawingType>(["bosbull", "bosbear", "chochbull", "chochbear"]);
const FIB_TYPE: DrawingType = "fibretracement";

// No formal "backtest run" concept exists anywhere in this app today (it's
// an interactive terminal, not a batch runner) - generated once per page
// load as a reasonable stand-in, kept distinct from sessionId in case a
// real backtest-run id shows up later and only backtestId needs to change.
export const marketStructureBacktestId = "bt-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// A drawing's geometry settles into whatever the last update() call left in
// the store; there's no separate "drag committed" event to listen for. This
// debounce is what turns a burst of per-frame drag updates into the single
// persisted edit the user asked for ("do not write on every mouse
// movement... once a drawing operation is completed, persist it").
const EDIT_DEBOUNCE_MS = 600;
const editTimers = new Map<string, ReturnType<typeof setTimeout>>();

function classify(type: DrawingType): { kind: MarketStructureKind; direction: MarketStructureDirection } | null {
  switch (type) {
    case "bosbull":
      return { kind: "BOS", direction: "bullish" };
    case "bosbear":
      return { kind: "BOS", direction: "bearish" };
    case "chochbull":
      return { kind: "CHOCH", direction: "bullish" };
    case "chochbear":
      return { kind: "CHOCH", direction: "bearish" };
    default:
      return null;
  }
}

function parsePaneKey(key: string): { symbol: string; timeframe: Timeframe } | null {
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  return { symbol: key.slice(0, idx), timeframe: key.slice(idx + 1) as Timeframe };
}

async function fetchBars(symbol: string, timeframe: Timeframe): Promise<CandleBar[]> {
  try {
    const data = await dataLayer.getSymbolData(symbol, timeframe);
    return data.bars;
  } catch {
    // Data not reachable/loaded yet - the record is still written, just
    // with null range measurements (see measureStructure with bars=[]),
    // never silently dropped.
    return [];
  }
}

function pointsEqual(a: DrawingPoint[], b: DrawingPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.time === b[i].time && p.price === b[i].price);
}

function findPreviousStructureId(symbol: string, timeframe: string): string | null {
  const all = useMarketStructureStore
    .getState()
    .marketStructures.filter((m) => m.symbol === symbol && m.timeframe === timeframe && m.status === "active");
  if (all.length === 0) return null;
  return all.reduce((latest, m) => (m.createdSequence > latest.createdSequence ? m : latest)).id;
}

async function handleCreateMarketStructure(paneKey: string, obj: DrawingObject) {
  const cls = classify(obj.type);
  const pane = parsePaneKey(paneKey);
  if (!cls || !pane) return;
  const bars = await fetchBars(pane.symbol, pane.timeframe);
  // The drawing may have been deleted (or edited again) while bars were loading.
  const current = useDrawingStore.getState().byPane[paneKey]?.find((d) => d.id === obj.id);
  if (!current) return;

  const m = measureStructure(bars, current.points[0], current.points[1]);
  const { id, sequence } = useMarketStructureStore.getState().nextId("ms");
  const now = Date.now();
  const event: MarketStructureEvent = {
    id,
    type: cls.kind,
    direction: cls.direction,
    start: m.start,
    end: m.end,
    rangeCandles: m.rangeCandles,
    rangePercent: m.rangePercent,
    rangePercentPerCandle: m.rangePercentPerCandle,
    rangeHigh: m.rangeHigh,
    rangeLow: m.rangeLow,
    absolutePriceDistance: m.absolutePriceDistance,
    directionalMovePercent: m.directionalMovePercent,
    retracementAvailable: false,
    retracementPercent: null,
    retracementCandles: null,
    symbol: pane.symbol,
    timeframe: pane.timeframe,
    sessionId: marketStructureSessionId,
    backtestId: marketStructureBacktestId,
    startTimestamp: m.startTimestamp,
    endTimestamp: m.endTimestamp,
    durationMinutes: m.durationMinutes,
    durationCandles: m.durationCandles,
    previousStructureId: findPreviousStructureId(pane.symbol, pane.timeframe),
    relatedFibonacci: null,
    rawDrawing: structuredClone(current),
    status: "active",
    deletedAt: null,
    revision: 1,
    editHistory: [{ revision: 1, start: m.start, end: m.end, editedAt: now }],
    userNote: null,
    userClassification: null,
    createdSequence: sequence,
    createdAt: now,
    updatedAt: now,
  };
  useMarketStructureStore.getState().addMarketStructure(event);
  useMarketStructureStore.getState().appendDrawingEvent({
    id: "evt-" + id,
    action: "create",
    targetId: id,
    targetKind: "marketStructure",
    timestamp: now,
    snapshot: [m.start, m.end],
  });
}

async function commitMarketStructureEdit(paneKey: string, drawingId: string, msId: string) {
  const pane = parsePaneKey(paneKey);
  const current = useDrawingStore.getState().byPane[paneKey]?.find((d) => d.id === drawingId);
  if (!pane || !current) return; // deleted before the debounce fired
  const bars = await fetchBars(pane.symbol, pane.timeframe);
  const latest = useDrawingStore.getState().byPane[paneKey]?.find((d) => d.id === drawingId);
  if (!latest) return;

  const m = measureStructure(bars, latest.points[0], latest.points[1]);
  const existing = useMarketStructureStore.getState().marketStructures.find((x) => x.id === msId);
  if (!existing || existing.status !== "active") return;
  const now = Date.now();
  const revision: MarketStructureRevision = { revision: existing.revision + 1, start: m.start, end: m.end, editedAt: now };
  useMarketStructureStore.getState().editMarketStructure(msId, revision, {
    start: m.start,
    end: m.end,
    rangeCandles: m.rangeCandles,
    rangePercent: m.rangePercent,
    rangePercentPerCandle: m.rangePercentPerCandle,
    rangeHigh: m.rangeHigh,
    rangeLow: m.rangeLow,
    absolutePriceDistance: m.absolutePriceDistance,
    directionalMovePercent: m.directionalMovePercent,
    startTimestamp: m.startTimestamp,
    endTimestamp: m.endTimestamp,
    durationMinutes: m.durationMinutes,
    durationCandles: m.durationCandles,
    rawDrawing: structuredClone(latest),
  });
  useMarketStructureStore.getState().appendDrawingEvent({
    id: "evt-" + msId + "-r" + revision.revision,
    action: "edit",
    targetId: msId,
    targetKind: "marketStructure",
    timestamp: now,
    snapshot: [m.start, m.end],
  });
}

function scheduleMarketStructureEdit(paneKey: string, drawingId: string, msId: string) {
  const timerKey = `ms:${drawingId}`;
  const existing = editTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  editTimers.set(
    timerKey,
    setTimeout(() => {
      editTimers.delete(timerKey);
      void commitMarketStructureEdit(paneKey, drawingId, msId);
    }, EDIT_DEBOUNCE_MS)
  );
}

function findMarketStructureIdForDrawing(drawingId: string): string | null {
  const found = useMarketStructureStore.getState().marketStructures.find((m) => m.rawDrawing.id === drawingId && m.status === "active");
  return found?.id ?? null;
}

async function handleCreateFibonacci(paneKey: string, obj: DrawingObject) {
  const pane = parsePaneKey(paneKey);
  if (!pane) return;
  const current = useDrawingStore.getState().byPane[paneKey]?.find((d) => d.id === obj.id);
  if (!current) return;

  const { id, sequence } = useMarketStructureStore.getState().nextId("fib");
  const now = Date.now();
  const event = buildFibonacciEvent(id, sequence, pane.symbol, pane.timeframe, current, now, now);
  useMarketStructureStore.getState().addFibonacciEvent(event);
  useMarketStructureStore.getState().appendDrawingEvent({
    id: "evt-" + id,
    action: "create",
    targetId: id,
    targetKind: "fibonacci",
    timestamp: now,
    snapshot: null,
  });
}

function buildFibonacciEvent(
  id: string,
  sequence: number,
  symbol: string,
  timeframe: string,
  obj: DrawingObject,
  createdAt: number,
  updatedAt: number
): FibonacciEvent {
  const [p1, p2] = obj.points[0].time <= obj.points[1].time ? [obj.points[0], obj.points[1]] : [obj.points[1], obj.points[0]];
  const hi = Math.max(p1.price, p2.price);
  const lo = Math.min(p1.price, p2.price);
  const range = hi - lo;
  const levels: Record<string, number> = {};
  for (const f of FIB_LEVELS) levels[String(f)] = hi - f * range;

  return {
    id,
    startCandleIndex: -1,
    endCandleIndex: -1,
    startTimestamp: p1.time,
    endTimestamp: p2.time,
    startPrice: p1.price,
    endPrice: p2.price,
    levels,
    symbol,
    timeframe,
    rawDrawing: structuredClone(obj),
    status: "active",
    deletedAt: null,
    createdSequence: sequence,
    createdAt,
    updatedAt,
  };
}

async function resolveFibCandleIndices(id: string, symbol: string, timeframe: Timeframe) {
  const bars = await fetchBars(symbol, timeframe);
  if (!bars.length) return;
  const fib = useMarketStructureStore.getState().fibonacciEvents.find((f) => f.id === id);
  if (!fib || fib.status !== "active") return;
  const startCandleIndex = nearestIndexByTime(bars, fib.startTimestamp, (b) => b.time);
  const endCandleIndex = nearestIndexByTime(bars, fib.endTimestamp, (b) => b.time);
  useMarketStructureStore.getState().editFibonacciEvent(id, {
    startCandleIndex,
    endCandleIndex,
    startTimestamp: fib.startTimestamp,
    endTimestamp: fib.endTimestamp,
    startPrice: fib.startPrice,
    endPrice: fib.endPrice,
    levels: fib.levels,
    rawDrawing: fib.rawDrawing,
  });
}

async function commitFibonacciEdit(paneKey: string, drawingId: string, fibId: string) {
  const pane = parsePaneKey(paneKey);
  const latest = useDrawingStore.getState().byPane[paneKey]?.find((d) => d.id === drawingId);
  if (!pane || !latest) return;
  const existing = useMarketStructureStore.getState().fibonacciEvents.find((f) => f.id === fibId);
  if (!existing || existing.status !== "active") return;
  const rebuilt = buildFibonacciEvent(fibId, existing.createdSequence, pane.symbol, pane.timeframe, latest, existing.createdAt, Date.now());
  useMarketStructureStore.getState().editFibonacciEvent(fibId, {
    startCandleIndex: existing.startCandleIndex,
    endCandleIndex: existing.endCandleIndex,
    startTimestamp: rebuilt.startTimestamp,
    endTimestamp: rebuilt.endTimestamp,
    startPrice: rebuilt.startPrice,
    endPrice: rebuilt.endPrice,
    levels: rebuilt.levels,
    rawDrawing: rebuilt.rawDrawing,
  });
  useMarketStructureStore.getState().appendDrawingEvent({
    id: "evt-" + fibId + "-" + Date.now(),
    action: "edit",
    targetId: fibId,
    targetKind: "fibonacci",
    timestamp: Date.now(),
    snapshot: null,
  });
  void resolveFibCandleIndices(fibId, pane.symbol, pane.timeframe);
}

function scheduleFibonacciEdit(paneKey: string, drawingId: string, fibId: string) {
  const timerKey = `fib:${drawingId}`;
  const existing = editTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  editTimers.set(
    timerKey,
    setTimeout(() => {
      editTimers.delete(timerKey);
      void commitFibonacciEdit(paneKey, drawingId, fibId);
    }, EDIT_DEBOUNCE_MS)
  );
}

function findFibonacciIdForDrawing(drawingId: string): string | null {
  const found = useMarketStructureStore.getState().fibonacciEvents.find((f) => f.rawDrawing.id === drawingId && f.status === "active");
  return found?.id ?? null;
}

function diffPane(paneKey: string, before: DrawingObject[], after: DrawingObject[]) {
  const beforeById = new Map(before.map((d) => [d.id, d]));
  const afterById = new Map(after.map((d) => [d.id, d]));

  for (const [drawingId, obj] of beforeById) {
    if (afterById.has(drawingId)) continue;
    if (MS_TYPES.has(obj.type)) {
      clearTimeout(editTimers.get(`ms:${drawingId}`));
      editTimers.delete(`ms:${drawingId}`);
      const msId = findMarketStructureIdForDrawing(drawingId);
      if (msId) {
        useMarketStructureStore.getState().deleteMarketStructure(msId);
        useMarketStructureStore.getState().appendDrawingEvent({
          id: "evt-" + msId + "-del-" + Date.now(),
          action: "delete",
          targetId: msId,
          targetKind: "marketStructure",
          timestamp: Date.now(),
          snapshot: null,
        });
      }
    } else if (obj.type === FIB_TYPE) {
      clearTimeout(editTimers.get(`fib:${drawingId}`));
      editTimers.delete(`fib:${drawingId}`);
      const fibId = findFibonacciIdForDrawing(drawingId);
      if (fibId) {
        useMarketStructureStore.getState().deleteFibonacciEvent(fibId);
        useMarketStructureStore.getState().appendDrawingEvent({
          id: "evt-" + fibId + "-del-" + Date.now(),
          action: "delete",
          targetId: fibId,
          targetKind: "fibonacci",
          timestamp: Date.now(),
          snapshot: null,
        });
      }
    }
  }

  for (const [drawingId, obj] of afterById) {
    const prevObj = beforeById.get(drawingId);
    if (MS_TYPES.has(obj.type)) {
      if (!prevObj) {
        void handleCreateMarketStructure(paneKey, obj);
      } else if (!pointsEqual(prevObj.points, obj.points)) {
        const msId = findMarketStructureIdForDrawing(drawingId);
        if (msId) scheduleMarketStructureEdit(paneKey, drawingId, msId);
      }
    } else if (obj.type === FIB_TYPE) {
      if (!prevObj) {
        void handleCreateFibonacci(paneKey, obj);
      } else if (!pointsEqual(prevObj.points, obj.points)) {
        const fibId = findFibonacciIdForDrawing(drawingId);
        if (fibId) scheduleFibonacciEdit(paneKey, drawingId, fibId);
      }
    }
  }
}

let started = false;

/** Wires the observer up. Idempotent and side-effect-free to call more than
 * once (e.g. React StrictMode double-invoking effects) - only the first
 * call actually subscribes. */
export function startMarketStructureLogger() {
  if (started) return;
  started = true;
  let prevByPane = useDrawingStore.getState().byPane;

  useDrawingStore.subscribe((state) => {
    const byPane = state.byPane;
    if (byPane === prevByPane) return;
    const keys = new Set([...Object.keys(byPane), ...Object.keys(prevByPane)]);
    for (const key of keys) {
      const before = prevByPane[key] ?? [];
      const after = byPane[key] ?? [];
      if (before !== after) diffPane(key, before, after);
    }
    prevByPane = byPane;
  });

  // Backfill candle indices for any Fibonacci events created before bars
  // finished loading the first time (fetchBars failed -> [-1, -1] indices).
  for (const fib of useMarketStructureStore.getState().fibonacciEvents) {
    if (fib.startCandleIndex === -1 && fib.status === "active") {
      void resolveFibCandleIndices(fib.id, fib.symbol, fib.timeframe as Timeframe);
    }
  }
}
