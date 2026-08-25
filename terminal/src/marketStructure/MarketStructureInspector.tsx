import { useMarketStructureStore } from "./marketStructureStore";
import type { MarketStructureEvent, UserClassification } from "./types";
import "./MarketStructureInspector.css";

const MS_TYPES = new Set(["bosbull", "bosbear", "chochbull", "chochbear"]);

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", "Z");
}
function fmtPrice(p: number): string {
  return p.toFixed(5);
}
function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p.toFixed(3)}%`;
}

/** Shown alongside StyleInspector whenever exactly one BOS/CHoCH drawing is
 * selected - a read (mostly) view into the record marketStructureLogger.ts
 * produced for it, plus the two fields that stay user-editable
 * (userNote/userClassification are never auto-assigned). Reads
 * marketStructureStore directly by the selected drawing's id; never reaches
 * into drawingStore beyond the id/type it's already given. */
export function MarketStructureInspector({ paneKey, selectedIds }: { paneKey: string; selectedIds: string[] }) {
  const marketStructures = useMarketStructureStore((s) => s.marketStructures);
  void paneKey;

  if (selectedIds.length !== 1) return null;
  const drawingId = selectedIds[0];
  const record = marketStructures.find((m) => m.rawDrawing.id === drawingId && m.status === "active");
  if (!record) return null;
  if (!MS_TYPES.has(record.rawDrawing.type)) return null;

  return <InspectorBody record={record} />;
}

function InspectorBody({ record }: { record: MarketStructureEvent }) {
  function copyJson() {
    void navigator.clipboard.writeText(JSON.stringify(record, null, 2));
  }
  function setNote(note: string) {
    useMarketStructureStore.getState().setUserNote(record.id, note.length ? note : null);
  }
  function setClassification(cls: UserClassification) {
    useMarketStructureStore.getState().setUserClassification(record.id, cls);
  }

  return (
    <div className="ms-inspector">
      <div className="ms-inspector-header">
        <span className="ms-inspector-title">Market Structure Data</span>
        <button type="button" className="ms-copy-btn" title="Copy this record as JSON" onClick={copyJson}>
          Copy JSON
        </button>
      </div>
      <div className="ms-inspector-grid">
        <Row label="ID" value={record.id} />
        <Row label="Type" value={record.type} />
        <Row label="Direction" value={record.direction} />
        <Row label="Start" value={`#${record.start.candleIndex}  ${fmtTime(record.start.timestamp)}  ${fmtPrice(record.start.price)}`} />
        <Row label="End" value={`#${record.end.candleIndex}  ${fmtTime(record.end.timestamp)}  ${fmtPrice(record.end.price)}`} />
        <Row label="Range candles" value={String(record.rangeCandles)} />
        <Row label="Range %" value={fmtPct(record.rangePercent)} />
        <Row
          label="Range high"
          value={record.rangeHigh ? `#${record.rangeHigh.candleIndex}  ${fmtPrice(record.rangeHigh.price)}` : "—"}
        />
        <Row label="Range low" value={record.rangeLow ? `#${record.rangeLow.candleIndex}  ${fmtPrice(record.rangeLow.price)}` : "—"} />
        <Row label="Range % / candle" value={fmtPct(record.rangePercentPerCandle)} />
        <Row label="Directional move %" value={fmtPct(record.directionalMovePercent)} />
        <Row
          label="Retracement"
          value={record.retracementAvailable ? fmtPct(record.retracementPercent) : "not determinable"}
        />
        <Row label="Retracement candles" value={record.retracementCandles == null ? "—" : String(record.retracementCandles)} />
        <Row label="Previous structure" value={record.previousStructureId ?? "—"} />
        <Row label="Created sequence" value={String(record.createdSequence)} />
        <Row label="Revision" value={String(record.revision)} />
        <Row label="Status" value={record.status} />
      </div>

      <label className="ms-note-label">
        Note
        <textarea
          className="ms-note-input"
          rows={2}
          value={record.userNote ?? ""}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Free-text notes on this structure"
        />
      </label>

      <div className="ms-classification">
        {(["valid", "invalid", "uncertain"] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`ms-class-btn${record.userClassification === c ? " active" : ""}`}
            onClick={() => setClassification(record.userClassification === c ? null : c)}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="ms-row-label">{label}</span>
      <span className="ms-row-value">{value}</span>
    </>
  );
}
