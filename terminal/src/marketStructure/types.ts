import type { DrawingObject } from "../drawing/types";

/**
 * Schema for the manual market-structure dataset (architecture doc has no
 * section for this yet - see src/marketStructure/marketStructureLogger.ts
 * for how these records get produced). This is a pure DATA-COLLECTION
 * layer: every record here mirrors something the user actually drew on the
 * chart (a bosbull/bosbear/chochbull/chochbear DrawingObject). Nothing in
 * this file classifies, scores, or infers correctness - it only measures
 * (candle counts, percentages, durations) facts that follow directly from
 * the two points the user placed and the real candle data between them.
 */

export type MarketStructureKind = "BOS" | "CHOCH";
export type MarketStructureDirection = "bullish" | "bearish";
export type MarketStructureStatus = "active" | "deleted";
export type UserClassification = "valid" | "invalid" | "uncertain" | null;

export interface MarketStructurePoint {
  candleIndex: number;
  timestamp: number; // unix seconds
  price: number;
}

/** One snapshot of start/end geometry, captured every time an existing
 * structure's points change (a drag, a handle edit). revision 1 is the
 * geometry at creation; the CURRENT start/end on the record itself is
 * always the latest revision's geometry, kept as top-level fields too so
 * consumers don't need to reach into editHistory for the common case. */
export interface MarketStructureRevision {
  revision: number;
  start: MarketStructurePoint;
  end: MarketStructurePoint;
  editedAt: number;
}

export interface MarketStructureEvent {
  id: string;
  type: MarketStructureKind;
  direction: MarketStructureDirection;

  start: MarketStructurePoint;
  end: MarketStructurePoint;

  rangeCandles: number;
  /** (highestHigh - lowestLow) / lowestLow * 100 over the real candle range
   * between start and end - NOT the same as directionalMovePercent below.
   * null only when the candle data needed to compute it wasn't available
   * (e.g. bars for this symbol/timeframe hadn't loaded yet). */
  rangePercent: number | null;
  rangePercentPerCandle: number | null;
  rangeHigh: MarketStructurePoint | null;
  rangeLow: MarketStructurePoint | null;

  /** abs(end.price - start.price) - a raw price distance, unit-dependent
   * (pips/points mean different things per instrument), kept alongside the
   * percent fields rather than instead of them. */
  absolutePriceDistance: number;
  /** (end.price - start.price) / start.price * 100 - the directional move
   * from start to end. Deliberately a separate field from rangePercent:
   * rangePercent measures the full high/low excursion of the range, this
   * measures start-to-end only, and they diverge whenever price overshoots
   * past the end point before settling there. */
  directionalMovePercent: number;

  /** True only when a retracement measurement can be derived without
   * inventing a rule the user didn't draw (e.g. from a linked Fibonacci
   * event). A bare 2-point BOS/CHoCH line has no third reference point to
   * measure retracement against, so today this is always false/null - it
   * exists so a future linked-Fibonacci or user-supplied retracement can
   * populate it without a schema change. null (not 0) means "not
   * determined"; 0 would mean "measured, and it was exactly zero". */
  retracementAvailable: boolean;
  retracementPercent: number | null;
  retracementCandles: number | null;

  symbol: string;
  timeframe: string;
  sessionId: string;
  backtestId: string;

  startTimestamp: number;
  endTimestamp: number;
  durationMinutes: number;
  durationCandles: number;

  /** Only ever set to another MarketStructureEvent's id, and only from
   * reliable creation order on the SAME symbol+timeframe pane - never
   * inferred from price proximity or "looks like a continuation". null for
   * the first structure drawn on a pane, or when the prior one was later
   * hard-deleted from the underlying array (soft-deletes keep the link
   * valid). */
  previousStructureId: string | null;
  /** Only set via a real id-based link the drawing system provides. This
   * app's Fibonacci tool has no such link today, so this is always null -
   * never guessed from the two drawings being near each other in time or
   * price. */
  relatedFibonacci: string | null;

  /** The originating DrawingObject, preserved verbatim (deep-cloned at
   * write time) so nothing here is ever "derived data with the source
   * discarded" - the raw points/style/props the user actually produced are
   * always recoverable. */
  rawDrawing: DrawingObject;

  status: MarketStructureStatus;
  deletedAt: number | null;

  revision: number;
  editHistory: MarketStructureRevision[];

  userNote: string | null;
  userClassification: UserClassification;

  createdSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface FibonacciEvent {
  id: string;
  startCandleIndex: number;
  endCandleIndex: number;
  startTimestamp: number;
  endTimestamp: number;
  startPrice: number;
  endPrice: number;
  /** Level -> absolute price, computed the same way the fib tool itself
   * renders levels (hi - level * range), kept unrounded. */
  levels: Record<string, number>;

  symbol: string;
  timeframe: string;

  rawDrawing: DrawingObject;

  status: MarketStructureStatus;
  deletedAt: number | null;

  createdSequence: number;
  createdAt: number;
  updatedAt: number;
}

export type DrawingEventAction = "create" | "edit" | "delete";

/** A flat, append-only action log - one entry per create/edit/delete the
 * logger observed, independent of the current-state records above. Kept
 * separate from editHistory/status because "what sequence of actions
 * actually happened" (draw a BOS, delete it, draw another) is itself data
 * the user asked to preserve, not just the end state of each id. */
export interface DrawingEventLogEntry {
  id: string;
  action: DrawingEventAction;
  targetId: string;
  targetKind: "marketStructure" | "fibonacci";
  timestamp: number;
  /** [start, end] geometry at the moment of this action; null for a delete
   * (nothing new to capture - the prior create/edit entries already have it). */
  snapshot: [MarketStructurePoint, MarketStructurePoint] | null;
}

export interface MarketStructureDatasetMetadata {
  symbol: string | null;
  timeframe: string | null;
  sessionId: string;
  backtestId: string;
  datasetVersion: 1;
  platformVersion: string;
  createdAt: number;
  exportedAt: number;
}

/** The exact shape of market_structure_dataset.json (export format - see
 * marketStructureExport.ts). The live/working copy of this data lives in
 * marketStructureStore (persisted to localStorage, same mechanism
 * drawingStore already uses); this shape is what "Download current
 * dataset" writes to disk, and what a future analysis pass would read. */
export interface MarketStructureDataset {
  metadata: MarketStructureDatasetMetadata;
  marketStructures: MarketStructureEvent[];
  fibonacciEvents: FibonacciEvent[];
  drawingEvents: DrawingEventLogEntry[];
}
