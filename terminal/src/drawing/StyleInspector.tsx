import { useDrawingStore } from "./drawingStore";
import { DRAWING_KINDS } from "./kinds";
import type { DrawingObject, DrawingStyle } from "./types";
import "./StyleInspector.css";

const SWATCHES = ["#e7ebf3", "#4f8cff", "#26a69a", "#ef5350", "#e0a64c", "#b177e0"];
const WIDTHS: DrawingStyle["lineWidth"][] = [1, 2, 3];

export function StyleInspector({
  paneKey,
  selectedIds,
  onDeselect,
}: {
  paneKey: string;
  selectedIds: string[];
  onDeselect: () => void;
}) {
  const drawings = useDrawingStore((s) => s.byPane[paneKey] ?? []);
  const selected = drawings.filter((d) => selectedIds.includes(d.id));
  if (selected.length === 0) return null;

  function patchStyle(patch: Partial<DrawingStyle>) {
    useDrawingStore.getState().mutate(paneKey, (ds) =>
      ds.map((d) => (selectedIds.includes(d.id) ? { ...d, style: { ...d.style, ...patch }, updatedAt: Date.now() } : d))
    );
  }

  function patchProps(patch: Record<string, unknown>) {
    useDrawingStore.getState().mutate(paneKey, (ds) =>
      ds.map((d) => (selectedIds.includes(d.id) ? { ...d, props: { ...d.props, ...patch }, updatedAt: Date.now() } : d))
    );
  }

  function remove() {
    useDrawingStore.getState().remove(paneKey, selectedIds);
    onDeselect();
  }

  const allLocked = selected.every((d) => d.locked);
  const allHidden = selected.every((d) => d.hidden);

  return (
    <div className="style-inspector">
      <span className="si-label">
        {selected.length === 1 ? DRAWING_KINDS[selected[0].type].label : `${selected.length} objects`}
      </span>

      <div className="si-swatches">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className={`si-swatch${selected.every((d) => d.style.color === c) ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => patchStyle({ color: c })}
          />
        ))}
      </div>
      <div className="si-widths">
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            className={`si-width${selected.every((d) => d.style.lineWidth === w) ? " active" : ""}`}
            title={`${w}px`}
            onClick={() => patchStyle({ lineWidth: w })}
          >
            <span style={{ height: w }} />
          </button>
        ))}
      </div>

      {selected.length === 1 && selected[0].type === "trendline" && (
        <TrendlineProps obj={selected[0]} patchProps={patchProps} />
      )}
      {selected.length === 1 && selected[0].type === "rectangle" && (
        <RectangleProps obj={selected[0]} patchProps={patchProps} />
      )}

      <div className="si-actions">
        <button
          type="button"
          className={`si-icon-btn${allLocked ? " active" : ""}`}
          title={allLocked ? "Unlock" : "Lock"}
          onClick={() => useDrawingStore.getState().setLocked(paneKey, selectedIds, !allLocked)}
        >
          {allLocked ? "🔒" : "🔓"}
        </button>
        <button
          type="button"
          className={`si-icon-btn${allHidden ? " active" : ""}`}
          title={allHidden ? "Show" : "Hide"}
          onClick={() => useDrawingStore.getState().setHidden(paneKey, selectedIds, !allHidden)}
        >
          {allHidden ? "🚫" : "👁"}
        </button>
        <button
          type="button"
          className="si-icon-btn"
          title="Duplicate (Ctrl+D)"
          onClick={() => useDrawingStore.getState().duplicate(paneKey, selectedIds)}
        >
          ⧉
        </button>
      </div>

      <button type="button" className="si-delete" title="Delete (Del)" onClick={remove}>
        &times;
      </button>
    </div>
  );
}

function TrendlineProps({ obj, patchProps }: { obj: DrawingObject; patchProps: (p: Record<string, unknown>) => void }) {
  return (
    <div className="si-toggles">
      <button
        type="button"
        className={`si-toggle${obj.props.extendLeft ? " active" : ""}`}
        title="Extend left"
        onClick={() => patchProps({ extendLeft: !obj.props.extendLeft })}
      >
        ⟸
      </button>
      <button
        type="button"
        className={`si-toggle${obj.props.extendRight ? " active" : ""}`}
        title="Extend right"
        onClick={() => patchProps({ extendRight: !obj.props.extendRight })}
      >
        ⟹
      </button>
      <button
        type="button"
        className={`si-toggle${obj.props.arrowStart ? " active" : ""}`}
        title="Arrow at start"
        onClick={() => patchProps({ arrowStart: !obj.props.arrowStart })}
      >
        ↞
      </button>
      <button
        type="button"
        className={`si-toggle${obj.props.arrowEnd ? " active" : ""}`}
        title="Arrow at end"
        onClick={() => patchProps({ arrowEnd: !obj.props.arrowEnd })}
      >
        ↠
      </button>
    </div>
  );
}

function RectangleProps({ obj, patchProps }: { obj: DrawingObject; patchProps: (p: Record<string, unknown>) => void }) {
  const opacity = typeof obj.props.fillOpacity === "number" ? (obj.props.fillOpacity as number) : 0.15;
  return (
    <div className="si-toggles">
      <button
        type="button"
        className={`si-toggle${obj.props.extendLeft ? " active" : ""}`}
        title="Extend left"
        onClick={() => patchProps({ extendLeft: !obj.props.extendLeft })}
      >
        ⟸
      </button>
      <button
        type="button"
        className={`si-toggle${obj.props.extendRight ? " active" : ""}`}
        title="Extend right"
        onClick={() => patchProps({ extendRight: !obj.props.extendRight })}
      >
        ⟹
      </button>
      <input
        type="range"
        min={0}
        max={0.6}
        step={0.05}
        value={opacity}
        title={`Fill opacity: ${Math.round(opacity * 100)}%`}
        onChange={(e) => patchProps({ fillOpacity: Number(e.target.value) })}
        className="si-opacity"
      />
    </div>
  );
}
