import { useLayoutEffect, useRef, useState } from "react";
import "./ChartContextMenu.css";

export interface ChartContextMenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** One row per action, a divider between each group - mirrors
 * drawing/DrawingContextMenu.tsx's own manual-divider layout rather than a
 * heavier generic "section with title" system, to stay a compact menu, not
 * a giant one. */
export type ChartContextMenuGroups = ChartContextMenuAction[][];

/** Pure viewport-clamping math, exported (and unit-tested) separately from
 * the component itself the same way LeftToolRail.tsx's selectDefaultTool()
 * is - this repo's vitest setup is pure-logic/node only (no jsdom/RTL), so
 * this is what "does not overflow the viewport" is actually verified
 * against, rather than a DOM-rendering test this setup can't run. Flips
 * left/up (never right/down, which is already the default open direction)
 * exactly enough to keep the menu's bounding box inside
 * [0, viewportWidth] x [0, viewportHeight], clamped at `margin` from either
 * edge so it never touches the browser chrome exactly at 0. */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): { left: number; top: number } {
  let left = x;
  let top = y;
  if (left + menuWidth > viewportWidth - margin) left = Math.max(margin, x - menuWidth);
  if (top + menuHeight > viewportHeight - margin) top = Math.max(margin, y - menuHeight);
  return { left, top };
}

export function ChartContextMenu({
  x,
  y,
  groups,
  onClose,
}: {
  x: number;
  y: number;
  groups: ChartContextMenuGroups;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Same "clamp inside the viewport" need every context menu here has, but
  // (unlike drawing/DrawingContextMenu.tsx, which never needed it - drawing
  // right-clicks rarely land at the extreme viewport edge) actually
  // implemented: the menu's real size isn't known until it's painted once,
  // so this measures it in a layout effect (before the browser paints,
  // avoiding a visible flash/jump) and flips left/up if it would overflow.
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
    // Only ever needs to run once per menu instance (a fresh x/y always
    // means a fresh mount - see ChartPane.tsx's key usage) - re-measuring
    // on every render would fight the flip decision back and forth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
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

  return (
    <div ref={ref} className="chart-context-menu" style={{ left: pos.left, top: pos.top }}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="ccm-divider" />}
          {group.map((action, ai) => (
            <button
              key={ai}
              type="button"
              className={action.danger ? "ccm-danger" : undefined}
              disabled={action.disabled}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
