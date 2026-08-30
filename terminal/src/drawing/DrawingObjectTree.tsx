import type { DrawingObject } from "./types";
import { useDrawingStore } from "./drawingStore";
import { DRAWING_KINDS } from "./kinds";
import "./DrawingObjectTree.css";

/**
 * TradingView-style "Object Tree" - lists every drawing on one pane and
 * lets you select/lock/hide/delete it from the list, not just from the
 * chart itself. Deliberately reuses the exact store actions
 * StyleInspector.tsx already uses for the same operations (setLocked/
 * setHidden/remove/select) - no new drawing business logic, this is purely
 * a second UI surface onto state that already exists and is already
 * mutated the same way elsewhere.
 */
// A shared, stable fallback reference - `s.byPane[paneKey] ?? []` would
// otherwise allocate a NEW array every render whenever a pane has no
// entry in byPane yet (a symbol/timeframe with zero drawings ever
// placed), which React's useSyncExternalStore (what Zustand's hook is
// built on) sees as "the snapshot changed" on every single render -
// confirmed via a real repro: an infinite render loop ("Maximum update
// depth exceeded") the instant this component was pointed at a pane with
// no drawings. StyleInspector.tsx/DrawingContextMenu.tsx use the same `??
// []` shorthand safely only because they're never mounted except when
// `selectedIds` already references a drawing in that exact pane (so
// byPane[paneKey] is always already a real array by the time they read
// it) - this component is the first one that reads a pane's drawings
// unconditionally, including the empty case, so it needs the stable
// reference.
const EMPTY_DRAWINGS: DrawingObject[] = [];

export function DrawingObjectTree({ paneKey }: { paneKey: string }) {
  const drawings = useDrawingStore((s) => s.byPane[paneKey] ?? EMPTY_DRAWINGS);
  const selectedIds = useDrawingStore((s) => s.selectedIds);

  if (drawings.length === 0) {
    return <div className="panel-empty">No drawings on this chart</div>;
  }

  // Most-recently-on-top first, matching the chart's own z-order (higher
  // zIndex renders on top - see kinds.ts/DrawingLayer.tsx's own sort).
  const sorted = [...drawings].sort((a, b) => b.zIndex - a.zIndex);

  return (
    <div className="object-tree panel-scroll">
      {sorted.map((d) => {
        const kind = DRAWING_KINDS[d.type];
        const isSelected = selectedIds.includes(d.id);
        return (
          <div
            key={d.id}
            className={`object-tree-row${isSelected ? " active" : ""}`}
            onClick={() => useDrawingStore.getState().select(d.id)}
          >
            <span className="object-tree-swatch" style={{ background: d.style.color }} />
            <span className="object-tree-label">{kind?.label ?? d.type}</span>
            <button
              type="button"
              className="object-tree-icon"
              title={d.locked ? "Unlock" : "Lock"}
              onClick={(e) => {
                e.stopPropagation();
                useDrawingStore.getState().setLocked(paneKey, [d.id], !d.locked);
              }}
            >
              {d.locked ? "🔒" : "🔓"}
            </button>
            <button
              type="button"
              className="object-tree-icon"
              title={d.hidden ? "Show" : "Hide"}
              onClick={(e) => {
                e.stopPropagation();
                useDrawingStore.getState().setHidden(paneKey, [d.id], !d.hidden);
              }}
            >
              {d.hidden ? "🚫" : "👁"}
            </button>
            <button
              type="button"
              className="object-tree-icon object-tree-delete"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                useDrawingStore.getState().remove(paneKey, [d.id]);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
