import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import { useDrawingStore } from "./drawingStore";
import "./TextEditOverlay.css";

interface TextEditOverlayProps {
  paneKey: string;
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  drawingId: string;
  onClose: () => void;
}

/**
 * DOM overlay (not canvas, not a primitive) for editing a `text` drawing's
 * content - real text editing needs a real input, the same reasoning
 * StyleInspector/DrawingContextMenu already use for their own chrome.
 * Positioned via the same chart.timeScale().timeToCoordinate() /
 * series.priceToCoordinate() calls every other overlay in this codebase
 * uses, so it tracks pan/zoom/resize exactly like the drawing itself does -
 * it just re-renders on the object's own point (a React re-render per
 * store-selector change), not a canvas rAF loop.
 */
export function TextEditOverlay({ paneKey, chart, series, drawingId, onClose }: TextEditOverlayProps) {
  const obj = useDrawingStore((s) => s.byPane[paneKey]?.find((d) => d.id === drawingId));
  const initialText = typeof obj?.props.text === "string" ? obj.props.text : "";
  const [value, setValue] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  if (!obj) return null;
  const x = chart.timeScale().timeToCoordinate(obj.points[0].time as Time);
  const y = series.priceToCoordinate(obj.points[0].price);
  if (x == null || y == null) return null;

  function close() {
    if (closedRef.current) return; // onBlur firing after Enter/Escape already committed/cancelled - commit exactly once
    closedRef.current = true;
    onClose();
  }

  function commit() {
    const trimmed = value.trim();
    if (!trimmed) {
      // An empty text object is invisible and can't be dragged by its body
      // (kinds.ts's `text` render/hitTest both bail out on empty content) -
      // removing it rather than leaving that ghost behind matches what a
      // user committing an empty edit actually wants.
      useDrawingStore.getState().remove(paneKey, [drawingId]);
    } else {
      useDrawingStore
        .getState()
        .mutate(paneKey, (ds) => ds.map((d) => (d.id === drawingId ? { ...d, props: { ...d.props, text: trimmed }, updatedAt: Date.now() } : d)));
    }
    close();
  }

  function cancel() {
    // Deliberately no store write - props.text is left exactly as it was
    // before editing opened (empty for a brand-new text object, which then
    // reads as "never actually placed" the same way an empty commit does;
    // untouched for a re-edit of existing text).
    if (!initialText) useDrawingStore.getState().remove(paneKey, [drawingId]);
    close();
  }

  return (
    <textarea
      ref={textareaRef}
      className="text-edit-overlay"
      style={{ left: x, top: y }}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}
