import { useEffect, useRef } from "react";
import { useDrawingStore } from "./drawingStore";
import "./DrawingContextMenu.css";

export interface ContextMenuState {
  x: number;
  y: number;
  ids: string[];
}

export function DrawingContextMenu({
  state,
  paneKey,
  onClose,
  onDuplicate,
}: {
  state: ContextMenuState;
  paneKey: string;
  onClose: () => void;
  onDuplicate: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drawings = useDrawingStore((s) => s.byPane[paneKey] ?? []);
  const selected = drawings.filter((d) => state.ids.includes(d.id));

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown, { capture: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown, { capture: true });
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (selected.length === 0) return null;
  const allLocked = selected.every((d) => d.locked);
  const allHidden = selected.every((d) => d.hidden);

  return (
    <div ref={ref} className="drawing-context-menu" style={{ left: state.x, top: state.y }}>
      <button type="button" onClick={() => { onDuplicate(state.ids); onClose(); }}>
        Duplicate <span className="dcm-shortcut">Ctrl+D</span>
      </button>
      <button
        type="button"
        onClick={() => {
          useDrawingStore.getState().setLocked(paneKey, state.ids, !allLocked);
          onClose();
        }}
      >
        {allLocked ? "Unlock" : "Lock"}
      </button>
      <button
        type="button"
        onClick={() => {
          useDrawingStore.getState().setHidden(paneKey, state.ids, !allHidden);
          onClose();
        }}
      >
        {allHidden ? "Show" : "Hide"}
      </button>
      {state.ids.length === 1 && (
        <>
          <div className="dcm-divider" />
          <button type="button" onClick={() => { useDrawingStore.getState().bringForward(paneKey, state.ids[0]); onClose(); }}>
            Bring Forward
          </button>
          <button type="button" onClick={() => { useDrawingStore.getState().sendBackward(paneKey, state.ids[0]); onClose(); }}>
            Send Backward
          </button>
        </>
      )}
      <div className="dcm-divider" />
      <button
        type="button"
        className="dcm-delete"
        onClick={() => {
          useDrawingStore.getState().remove(paneKey, state.ids);
          onClose();
        }}
      >
        Delete <span className="dcm-shortcut">Del</span>
      </button>
    </div>
  );
}
