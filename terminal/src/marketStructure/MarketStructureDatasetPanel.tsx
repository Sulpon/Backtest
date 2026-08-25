import { useMemo, useState } from "react";
import { useUiStore } from "../workspace/uiStore";
import { useMarketStructureStore } from "./marketStructureStore";
import { downloadDatasetCsv, downloadDatasetJson } from "./marketStructureExport";
import type { MarketStructureEvent } from "./types";
import "../components/modal.css";
import "./MarketStructureDatasetPanel.css";

type SortKey = "time" | "sequence" | "type" | "direction";
type TypeFilter = "all" | "BOS" | "CHOCH";
type DirectionFilter = "all" | "bullish" | "bearish";
type StatusFilter = "all" | "active" | "deleted";

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}
function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p.toFixed(3)}%`;
}

export function MarketStructureDatasetPanel() {
  const open = useUiStore((s) => s.marketStructureDatasetOpen);
  const setOpen = useUiStore((s) => s.setMarketStructureDatasetOpen);
  const marketStructures = useMarketStructureStore((s) => s.marketStructures);

  const [sortKey, setSortKey] = useState<SortKey>("sequence");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  const rows = useMemo(() => {
    let out = marketStructures;
    if (typeFilter !== "all") out = out.filter((m) => m.type === typeFilter);
    if (directionFilter !== "all") out = out.filter((m) => m.direction === directionFilter);
    if (statusFilter !== "all") out = out.filter((m) => m.status === statusFilter);
    out = [...out].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "time":
          cmp = a.startTimestamp - b.startTimestamp;
          break;
        case "sequence":
          cmp = a.createdSequence - b.createdSequence;
          break;
        case "type":
          cmp = a.type.localeCompare(b.type);
          break;
        case "direction":
          cmp = a.direction.localeCompare(b.direction);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [marketStructures, typeFilter, directionFilter, statusFilter, sortKey, sortDir]);

  if (!open) return null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const activePane = marketStructures[marketStructures.length - 1];

  return (
    <div className="ah-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="ah-modal msd-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ah-header">
          <span className="ah-title">Market Structure Dataset</span>
          <button type="button" className="ah-close" onClick={() => setOpen(false)}>
            &times;
          </button>
        </div>

        <div className="msd-toolbar">
          <FilterSelect label="Type" value={typeFilter} onChange={setTypeFilter} options={["all", "BOS", "CHOCH"]} />
          <FilterSelect
            label="Direction"
            value={directionFilter}
            onChange={setDirectionFilter}
            options={["all", "bullish", "bearish"]}
          />
          <FilterSelect label="Status" value={statusFilter} onChange={setStatusFilter} options={["all", "active", "deleted"]} />
          <div className="msd-spacer" />
          <span className="msd-count">
            {rows.length} of {marketStructures.length}
          </span>
          <button
            type="button"
            className="msd-export-btn"
            onClick={() => downloadDatasetJson(activePane?.symbol ?? null, activePane?.timeframe ?? null)}
          >
            Export JSON
          </button>
          <button type="button" className="msd-export-btn" onClick={() => downloadDatasetCsv()}>
            Export CSV
          </button>
        </div>

        <div className="msd-table-wrap">
          <table className="msd-table">
            <thead>
              <tr>
                <SortableTh label="Seq" sortKey="sequence" active={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableTh label="Type" sortKey="type" active={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableTh label="Direction" sortKey="direction" active={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableTh label="Start" sortKey="time" active={sortKey} dir={sortDir} onClick={toggleSort} />
                <th>End</th>
                <th>Range candles</th>
                <th>Range %</th>
                <th>Dir. move %</th>
                <th>Status</th>
                <th>Rev</th>
                <th>Class.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <Row key={m.id} m={m} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="msd-empty">
                    No structures match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ m }: { m: MarketStructureEvent }) {
  return (
    <tr className={m.status === "deleted" ? "msd-row-deleted" : ""}>
      <td>{m.createdSequence}</td>
      <td>{m.type}</td>
      <td>{m.direction}</td>
      <td>{fmtTime(m.startTimestamp)}</td>
      <td>{fmtTime(m.endTimestamp)}</td>
      <td>{m.rangeCandles}</td>
      <td>{fmtPct(m.rangePercent)}</td>
      <td>{fmtPct(m.directionalMovePercent)}</td>
      <td>{m.status}</td>
      <td>{m.revision}</td>
      <td>{m.userClassification ?? "—"}</td>
    </tr>
  );
}

function SortableTh<K extends string>({
  label,
  sortKey,
  active,
  dir,
  onClick,
}: {
  label: string;
  sortKey: K;
  active: K;
  dir: "asc" | "desc";
  onClick: (key: K) => void;
}) {
  return (
    <th className="msd-sortable" onClick={() => onClick(sortKey)}>
      {label}
      {active === sortKey && <span className="msd-sort-arrow">{dir === "asc" ? " ▲" : " ▼"}</span>}
    </th>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: T[];
}) {
  return (
    <label className="msd-filter">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
