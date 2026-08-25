import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { CandleBar } from "../data/types";
import type { DrawingObject, DrawingType } from "./types";
import { DEFAULT_STYLE } from "./types";
import { DRAWING_KINDS, HANDLE_RADIUS, SELECT_COLOR, type DrawScale } from "./kinds";
import { snapPoint } from "./geometry";
import { useDrawingStore } from "./drawingStore";
import { useUiStore } from "../workspace/uiStore";
import { useSettingsStore } from "../settings/settingsStore";
import { getModifierKeys, setActivePaneKey, getActivePaneKey } from "./interactionState";
import { StyleInspector } from "./StyleInspector";
import { MarketStructureInspector } from "../marketStructure/MarketStructureInspector";
import { DrawingContextMenu, type ContextMenuState } from "./DrawingContextMenu";
import "./DrawingLayer.css";

interface DragState {
  mode: "handle" | "move" | "resize";
  id: string;
  handleIndex?: number;
  resizeHandleId?: string;
  startPoints: DrawingObject["points"];
  startPointer: { time: number; price: number };
}

interface DrawingLayerProps {
  containerEl: HTMLDivElement;
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  bars: CandleBar[];
  paneKey: string;
}

export function DrawingLayer({ containerEl, chart, series, bars, paneKey }: DrawingLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const paneKeyRef = useRef(paneKey);
  paneKeyRef.current = paneKey;

  const pendingRef = useRef<{ type: DrawingType; points: DrawingObject["points"] } | null>(null);
  const hoverPxRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [selectedIds, setSelectedIdsState] = useState<string[]>([]);
  const selectedIdsRef = useRef<string[]>([]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  function setSelection(ids: string[]) {
    selectedIdsRef.current = ids;
    setSelectedIdsState(ids);
    useDrawingStore.setState({ selectedIds: ids });
  }
  function select(id: string | null) {
    setSelection(id ? [id] : []);
  }
  function toggleInSelection(id: string) {
    const ids = selectedIdsRef.current.includes(id)
      ? selectedIdsRef.current.filter((x) => x !== id)
      : [...selectedIdsRef.current, id];
    setSelection(ids);
  }

  function buildScale(width: number, height: number): DrawScale {
    const x = (t: number) => chart.timeScale().timeToCoordinate(t as Time);
    const y = (p: number) => series.priceToCoordinate(p);
    return {
      x,
      y,
      toPx: (t, p) => {
        const px = x(t);
        const py = y(p);
        return px == null || py == null ? null : { x: px, y: py };
      },
      fromPx: (px, py) => {
        const time = chart.timeScale().coordinateToTime(px);
        const price = series.coordinateToPrice(py);
        return time == null || price == null ? null : { time: time as number, price };
      },
      width,
      height,
    };
  }

  function pixelToData(clientX: number, clientY: number): { time: number; price: number } | null {
    const rect = containerEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time == null || price == null) return null;
    return { time: time as number, price };
  }

  function currentDrawings(): DrawingObject[] {
    return useDrawingStore.getState().getDrawings(paneKeyRef.current).filter((d) => !d.hidden);
  }

  function hitTestAll(x: number, y: number): { id: string; handleIndex?: number; resizeHandleId?: string } | null {
    const drawings = currentDrawings();
    const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);
    const sorted = [...drawings].sort((a, b) => a.zIndex - b.zIndex);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const obj = sorted[i];
      const kind = DRAWING_KINDS[obj.type];
      const isSelected = selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === obj.id;
      if (isSelected && !obj.locked) {
        const resizeHandles = kind.resizeHandles?.(obj, scale) ?? [];
        for (const h of resizeHandles) {
          if (Math.hypot(h.pixel.x - x, h.pixel.y - y) <= HANDLE_RADIUS + 4) {
            return { id: obj.id, resizeHandleId: h.id };
          }
        }
        for (const idx of kind.handleIndices(obj)) {
          const p = kind.handlePixel ? kind.handlePixel(idx, obj, scale) : scale.toPx(obj.points[idx].time, obj.points[idx].price);
          if (p && Math.hypot(p.x - x, p.y - y) <= HANDLE_RADIUS + 4) {
            return { id: obj.id, handleIndex: idx };
          }
        }
      }
      if (kind.hitTest(scale, obj, x, y)) return { id: obj.id };
    }
    return null;
  }

  // ---- render loop ----
  useEffect(() => {
    let raf = 0;
    const dpr = window.devicePixelRatio || 1;

    function draw() {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const scale = buildScale(w, h);
      const drawings = currentDrawings().sort((a, b) => a.zIndex - b.zIndex);

      drawings.forEach((obj) => {
        const kind = DRAWING_KINDS[obj.type];
        if (!kind) return;
        kind.render(ctx, scale, obj);
        if (selectedIdsRef.current.includes(obj.id)) {
          ctx.save();
          ctx.strokeStyle = SELECT_COLOR;
          ctx.fillStyle = SELECT_COLOR;
          kind.handleIndices(obj).forEach((idx) => {
            const p = kind.handlePixel ? kind.handlePixel(idx, obj, scale) : scale.toPx(obj.points[idx].time, obj.points[idx].price);
            if (!p) return;
            ctx.beginPath();
            ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
          });
          const single = selectedIdsRef.current.length === 1;
          if (single && !obj.locked) {
            (kind.resizeHandles?.(obj, scale) ?? []).forEach((h) => {
              ctx.beginPath();
              ctx.rect(h.pixel.x - HANDLE_RADIUS, h.pixel.y - HANDLE_RADIUS, HANDLE_RADIUS * 2, HANDLE_RADIUS * 2);
              ctx.fill();
            });
          }
          if (obj.locked) {
            ctx.font = "11px sans-serif";
            ctx.fillText("🔒", (scale.toPx(obj.points[0].time, obj.points[0].price)?.x ?? 0) + 8, (scale.toPx(obj.points[0].time, obj.points[0].price)?.y ?? 0) - 8);
          }
          ctx.restore();
        }
      });

      // live preview while placing a multi-point drawing
      const pending = pendingRef.current;
      const hover = hoverPxRef.current;
      if (pending && hover) {
        const hoverData = pixelToData(hover.x + containerEl.getBoundingClientRect().left, hover.y + containerEl.getBoundingClientRect().top);
        if (hoverData) {
          const kind = DRAWING_KINDS[pending.type];
          const anchor = pending.points[pending.points.length - 1];
          let freePoint = snapPoint(barsRef.current, hoverData.time, hoverData.price, useUiStore.getState().magnetEnabled);
          if (kind.constrainPoint && anchor) {
            freePoint = kind.constrainPoint([anchor], freePoint, scale, getModifierKeys());
          }
          const previewObj: DrawingObject = {
            id: "__preview__",
            type: pending.type,
            points: [...pending.points, freePoint],
            style: { ...DEFAULT_STYLE, ...kind.defaultStyle },
            props: {},
            locked: false,
            hidden: false,
            zIndex: 0,
            createdAt: 0,
            updatedAt: 0,
          };
          ctx.save();
          ctx.globalAlpha = 0.75;
          kind.render(ctx, scale, previewObj);
          ctx.restore();
        }
      }
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, containerEl]);

  // ---- pointer interaction ----
  useEffect(() => {
    function onMouseMoveHover(e: MouseEvent) {
      if (e.target instanceof HTMLElement && (e.target.closest(".style-inspector") || e.target.closest(".drawing-context-menu"))) return;
      const rect = containerEl.getBoundingClientRect();
      hoverPxRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      setActivePaneKey(paneKeyRef.current);
      if (dragRef.current) return;
      const tool = useUiStore.getState().activeToolId;
      if (DRAWING_KINDS[tool as DrawingType]) {
        containerEl.style.cursor = "crosshair";
        return;
      }
      const hit = hitTestAll(hoverPxRef.current.x, hoverPxRef.current.y);
      if (hit?.resizeHandleId) {
        const drawings = currentDrawings();
        const obj = drawings.find((d) => d.id === hit.id);
        const kind = obj && DRAWING_KINDS[obj.type];
        const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);
        const handle = obj && kind?.resizeHandles?.(obj, scale).find((h) => h.id === hit.resizeHandleId);
        containerEl.style.cursor = handle?.cursor ?? "grab";
        return;
      }
      containerEl.style.cursor = hit ? (hit.handleIndex != null ? "grab" : "move") : "";
    }

    function onWindowMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const data = pixelToData(e.clientX, e.clientY);
      if (!data) return;
      const snapped = snapPoint(barsRef.current, data.time, data.price, useUiStore.getState().magnetEnabled);
      const key = paneKeyRef.current;
      const drawings = useDrawingStore.getState().getDrawings(key);
      const obj = drawings.find((d) => d.id === drag.id);
      if (!obj) return;
      const kind = DRAWING_KINDS[obj.type];
      const modifiers = getModifierKeys();

      if (drag.mode === "resize" && drag.resizeHandleId) {
        const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);
        const startObj = { ...obj, points: drag.startPoints };
        const handles = kind.resizeHandles?.(startObj, scale) ?? [];
        const handle = handles.find((h) => h.id === drag.resizeHandleId);
        if (!handle) return;
        let target = snapped;
        if (modifiers.shift && handle.opposite) {
          const opposite = handles.find((h) => h.id === handle.opposite);
          const freePx = scale.toPx(target.time, target.price);
          if (opposite && freePx) {
            const dx = freePx.x - opposite.pixel.x;
            const dy = freePx.y - opposite.pixel.y;
            const m = Math.max(Math.abs(dx), Math.abs(dy));
            const adjPx = { x: opposite.pixel.x + Math.sign(dx || 1) * m, y: opposite.pixel.y + Math.sign(dy || 1) * m };
            const adjData = scale.fromPx(adjPx.x, adjPx.y);
            if (adjData) target = adjData;
          }
        }
        const newPoints = handle.apply(drag.startPoints, target);
        useDrawingStore.getState().update(key, (ds) => ds.map((d) => (d.id === drag.id ? { ...d, points: newPoints } : d)));
        return;
      }

      useDrawingStore.getState().update(key, (ds) =>
        ds.map((d) => {
          if (d.id !== drag.id) return d;
          if (drag.mode === "handle" && drag.handleIndex != null) {
            let point = snapped;
            if (modifiers.shift && kind.constrainPoint) {
              const anchor = drag.startPoints[1 - drag.handleIndex] ?? drag.startPoints[0];
              const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);
              point = kind.constrainPoint([anchor], point, scale, modifiers);
            }
            const pts = d.points.slice();
            pts[drag.handleIndex] = point;
            return { ...d, points: pts };
          }
          const dt = snapped.time - drag.startPointer.time;
          const dp = snapped.price - drag.startPointer.price;
          return { ...d, points: drag.startPoints.map((p) => ({ time: p.time + dt, price: p.price + dp })) };
        })
      );
    }

    function onWindowMouseUp() {
      dragRef.current = null;
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    }

    function startDrag(state: DragState) {
      // snapshot for undo BEFORE the drag mutates anything
      useDrawingStore.getState().mutate(paneKeyRef.current, (d) => d);
      dragRef.current = state;
      window.addEventListener("mousemove", onWindowMouseMove);
      window.addEventListener("mouseup", onWindowMouseUp);
    }

    function onMouseDownCapture(e: MouseEvent) {
      if (e.button !== 0) return;
      // Clicks on our own UI chrome (style inspector, context menu) aren't
      // chart interactions - let them proceed untouched.
      if (e.target instanceof HTMLElement && (e.target.closest(".style-inspector") || e.target.closest(".drawing-context-menu"))) return;
      setMenu(null);
      const rect = containerEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const tool = useUiStore.getState().activeToolId as DrawingType;
      const kind = DRAWING_KINDS[tool];
      const key = paneKeyRef.current;
      const modifiers = getModifierKeys();

      if (kind) {
        e.stopPropagation();
        e.preventDefault();
        const data = pixelToData(e.clientX, e.clientY);
        if (!data) return;
        let snapped = snapPoint(barsRef.current, data.time, data.price, useUiStore.getState().magnetEnabled);
        const pending = pendingRef.current;
        if (!pending || pending.type !== tool) {
          pendingRef.current = { type: tool, points: [snapped] };
        } else {
          const anchor = pending.points[pending.points.length - 1];
          if (kind.constrainPoint && anchor) {
            const scale = buildScale(containerEl.clientWidth, containerEl.clientHeight);
            snapped = kind.constrainPoint([anchor], snapped, scale, modifiers);
          }
          pending.points.push(snapped);
        }
        const cur = pendingRef.current!;
        if (cur.points.length >= kind.pointCount) {
          const meta = tool === "long" || tool === "short" ? { rr: useUiStore.getState().pendingRR } : undefined;
          const drawings = useDrawingStore.getState().getDrawings(key);
          const maxZ = drawings.reduce((m, d) => Math.max(m, d.zIndex), 0);
          const now = Date.now();
          const obj: DrawingObject = {
            id: "d" + now.toString(36) + Math.random().toString(36).slice(2, 7),
            type: tool,
            points: cur.points,
            style: { ...DEFAULT_STYLE, ...kind.defaultStyle },
            props: {},
            meta,
            locked: false,
            hidden: false,
            zIndex: maxZ + 1,
            createdAt: now,
            updatedAt: now,
          };
          useDrawingStore.getState().mutate(key, (ds) => [...ds, obj]);
          pendingRef.current = null;
          select(obj.id);
          if (!useUiStore.getState().toolLocked) useUiStore.getState().setActiveTool("cursor");
          else useUiStore.getState().setStatusHint(`${kind.label} placed - tool stays active`);
        } else {
          useUiStore.getState().setStatusHint(
            tool === "long" || tool === "short" ? "Now click the stop-loss level" : "Click the next point to finish"
          );
        }
        return;
      }

      const hit = hitTestAll(x, y);
      if (!hit) {
        if (!modifiers.ctrl && !modifiers.shift) setSelection([]);
        return; // let the chart handle it natively (pan)
      }
      e.stopPropagation();
      e.preventDefault();
      const drawings = useDrawingStore.getState().getDrawings(key);
      const obj = drawings.find((d) => d.id === hit.id);
      if (!obj) return;
      const isHandleHit = hit.handleIndex != null || hit.resizeHandleId != null;
      const isDuplicateDrag = modifiers.ctrl && !isHandleHit && selectedIdsRef.current.includes(obj.id) && !obj.locked;

      // Shift/Ctrl only mean "toggle selection" on a plain body click - on a
      // handle they mean "constrain this drag" (read live during the drag
      // itself via getModifierKeys()), so a handle hit always falls through
      // to a normal drag-start regardless of which modifiers are held.
      // Ctrl on an already-selected body is the duplicate-drag gesture, not
      // a toggle, so it's excluded here too.
      if (!isHandleHit && !isDuplicateDrag && (modifiers.ctrl || modifiers.shift)) {
        toggleInSelection(obj.id);
        return; // multi-select toggle never starts a drag
      }

      const data = pixelToData(e.clientX, e.clientY);
      if (!data) return;
      const snapped = snapPoint(barsRef.current, data.time, data.price, useUiStore.getState().magnetEnabled);

      // Ctrl+drag on an already-selected, unlocked object's body duplicates
      // it and drags the copy, leaving the original in place.
      if (isDuplicateDrag) {
        const [newId] = useDrawingStore.getState().duplicate(key, selectedIdsRef.current);
        select(newId);
        const dup = useDrawingStore.getState().getDrawings(key).find((d) => d.id === newId);
        if (dup) startDrag({ mode: "move", id: newId, startPoints: dup.points, startPointer: snapped });
        return;
      }

      if (!selectedIdsRef.current.includes(obj.id)) select(obj.id);
      if (obj.locked) return; // selectable, but never draggable while locked

      if (hit.resizeHandleId != null) {
        startDrag({ mode: "resize", id: obj.id, resizeHandleId: hit.resizeHandleId, startPoints: obj.points, startPointer: snapped });
      } else {
        startDrag({
          mode: hit.handleIndex != null ? "handle" : "move",
          id: obj.id,
          handleIndex: hit.handleIndex,
          startPoints: obj.points,
          startPointer: snapped,
        });
      }
    }

    function onContextMenu(e: MouseEvent) {
      if (e.target instanceof HTMLElement && (e.target.closest(".style-inspector") || e.target.closest(".drawing-context-menu"))) return;
      const rect = containerEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = hitTestAll(x, y);
      if (!hit) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      if (!selectedIdsRef.current.includes(hit.id)) select(hit.id);
      setMenu({ x: e.clientX, y: e.clientY, ids: selectedIdsRef.current.includes(hit.id) ? selectedIdsRef.current : [hit.id] });
    }

    containerEl.addEventListener("mousedown", onMouseDownCapture, { capture: true });
    containerEl.addEventListener("mousemove", onMouseMoveHover);
    containerEl.addEventListener("contextmenu", onContextMenu);
    return () => {
      containerEl.removeEventListener("mousedown", onMouseDownCapture, { capture: true });
      containerEl.removeEventListener("mousemove", onMouseMoveHover);
      containerEl.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerEl, chart, series]);

  // ---- keyboard ----
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const typing = document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
      if (typing) return;
      const key = paneKeyRef.current;
      if (e.key === "Escape") {
        pendingRef.current = null;
        useUiStore.getState().setActiveTool("cursor");
        select(null);
        setMenu(null);
        return;
      }
      // Everything below acts on a specific pane's drawings - only the pane
      // currently under the pointer should respond, so opening a second
      // chart pane doesn't make every keypress fire twice.
      if (key !== getActivePaneKey()) return;
      if ((e.key === useSettingsStore.getState().hotkeys.deleteDrawing || e.key === "Backspace") && selectedIdsRef.current.length) {
        useDrawingStore.getState().remove(key, selectedIdsRef.current);
        setSelection([]);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selectedIdsRef.current.length) {
        e.preventDefault();
        const newIds = useDrawingStore.getState().duplicate(key, selectedIdsRef.current);
        setSelection(newIds);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useDrawingStore.getState().redo(key);
        else useDrawingStore.getState().undo(key);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // deselect + clear in-progress placement when the pane's data identity changes
  useEffect(() => {
    pendingRef.current = null;
    select(null);
    setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneKey]);

  return (
    <>
      <canvas ref={canvasRef} className="drawing-layer-canvas" />
      {selectedIds.length > 0 && (
        <StyleInspector paneKey={paneKey} selectedIds={selectedIds} onDeselect={() => select(null)} />
      )}
      <MarketStructureInspector paneKey={paneKey} selectedIds={selectedIds} />
      {menu && (
        <DrawingContextMenu
          state={menu}
          paneKey={paneKey}
          onClose={() => setMenu(null)}
          onDuplicate={(ids) => {
            const newIds = useDrawingStore.getState().duplicate(paneKey, ids);
            setSelection(newIds);
          }}
        />
      )}
    </>
  );
}
