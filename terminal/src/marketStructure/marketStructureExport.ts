import type { MarketStructureDataset, MarketStructureEvent } from "./types";
import { useMarketStructureStore, marketStructureSessionId } from "./marketStructureStore";
import { marketStructureBacktestId } from "./marketStructureLogger";

const PLATFORM_VERSION = "1.0.0-market-structure-logger";

/** Builds the exact market_structure_dataset.json shape from the live
 * store. `symbol`/`timeframe` in metadata describe the CURRENTLY VIEWED
 * pane (informational only) - the arrays themselves are never filtered by
 * pane, so switching charts never loses data from the export. */
export function buildDataset(symbol: string | null, timeframe: string | null): MarketStructureDataset {
  const s = useMarketStructureStore.getState();
  const now = Date.now();
  return {
    metadata: {
      symbol,
      timeframe,
      sessionId: marketStructureSessionId,
      backtestId: marketStructureBacktestId,
      datasetVersion: 1,
      platformVersion: PLATFORM_VERSION,
      createdAt: s.marketStructures[0]?.createdAt ?? now,
      exportedAt: now,
    },
    marketStructures: s.marketStructures,
    fibonacciEvents: s.fibonacciEvents,
    drawingEvents: s.drawingEvents,
  };
}

function downloadText(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadDatasetJson(symbol: string | null, timeframe: string | null) {
  const dataset = buildDataset(symbol, timeframe);
  downloadText("market_structure_dataset.json", "application/json", JSON.stringify(dataset, null, 2));
}

const CSV_COLUMNS: { key: string; get: (m: MarketStructureEvent) => string | number }[] = [
  { key: "id", get: (m) => m.id },
  { key: "type", get: (m) => m.type },
  { key: "direction", get: (m) => m.direction },
  { key: "status", get: (m) => m.status },
  { key: "symbol", get: (m) => m.symbol },
  { key: "timeframe", get: (m) => m.timeframe },
  { key: "startCandleIndex", get: (m) => m.start.candleIndex },
  { key: "startTimestamp", get: (m) => m.startTimestamp },
  { key: "startPrice", get: (m) => m.start.price },
  { key: "endCandleIndex", get: (m) => m.end.candleIndex },
  { key: "endTimestamp", get: (m) => m.endTimestamp },
  { key: "endPrice", get: (m) => m.end.price },
  { key: "rangeCandles", get: (m) => m.rangeCandles },
  { key: "rangePercent", get: (m) => m.rangePercent ?? "" },
  { key: "rangePercentPerCandle", get: (m) => m.rangePercentPerCandle ?? "" },
  { key: "rangeHighPrice", get: (m) => m.rangeHigh?.price ?? "" },
  { key: "rangeLowPrice", get: (m) => m.rangeLow?.price ?? "" },
  { key: "absolutePriceDistance", get: (m) => m.absolutePriceDistance },
  { key: "directionalMovePercent", get: (m) => m.directionalMovePercent },
  { key: "retracementAvailable", get: (m) => String(m.retracementAvailable) },
  { key: "retracementPercent", get: (m) => m.retracementPercent ?? "" },
  { key: "retracementCandles", get: (m) => m.retracementCandles ?? "" },
  { key: "durationMinutes", get: (m) => m.durationMinutes },
  { key: "previousStructureId", get: (m) => m.previousStructureId ?? "" },
  { key: "relatedFibonacci", get: (m) => m.relatedFibonacci ?? "" },
  { key: "revision", get: (m) => m.revision },
  { key: "createdSequence", get: (m) => m.createdSequence },
  { key: "createdAt", get: (m) => m.createdAt },
  { key: "updatedAt", get: (m) => m.updatedAt },
  { key: "deletedAt", get: (m) => m.deletedAt ?? "" },
  { key: "userClassification", get: (m) => m.userClassification ?? "" },
  { key: "userNote", get: (m) => m.userNote ?? "" },
  { key: "sessionId", get: (m) => m.sessionId },
  { key: "backtestId", get: (m) => m.backtestId },
  // Full-fidelity nested data, one JSON blob per cell - the scalar columns
  // above are for spreadsheet skimming, these two are so the CSV never
  // loses information the JSON export has (revisions, the raw drawing).
  { key: "editHistoryJson", get: (m) => JSON.stringify(m.editHistory) },
  { key: "rawDrawingJson", get: (m) => JSON.stringify(m.rawDrawing) },
];

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadDatasetCsv() {
  const marketStructures = useMarketStructureStore.getState().marketStructures;
  const header = CSV_COLUMNS.map((c) => c.key).join(",");
  const rows = marketStructures.map((m) => CSV_COLUMNS.map((c) => csvCell(c.get(m))).join(","));
  downloadText("market_structure_dataset.csv", "text/csv", [header, ...rows].join("\n"));
}
