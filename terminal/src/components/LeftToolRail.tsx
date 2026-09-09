import { useState } from "react";
import { TOOL_GROUPS, TOOL_SHORTCUTS, TOOL_DESCRIPTIONS, type ToolDef, type ToolGroup } from "./toolDefinitions";
import { useUiStore } from "../workspace/uiStore";
import { useToolShortcuts } from "./useToolShortcuts";
import { DrawingIcon } from "./drawingIcons";
import "./LeftToolRail.css";

export const PLACEMENT_HINTS: Record<string, string> = {
  hline: "Click a price to place the horizontal line",
  trendline: "Click the first point, then the second",
  rectangle: "Click one corner, then the opposite corner",
  fibretracement: "Click the swing high (or low), then the other end",
  long: "Click the entry point, then the stop-loss level",
  short: "Click the entry point, then the stop-loss level",
  text: "Click to place the label, then type",
  arrow: "Click the start point, then the tip",
  circle: "Click the center, then drag out the edge",
  ellipse: "Click one corner, then the opposite corner",
  triangle: "Click each of the three corners",
  parallelchannel: "Click the baseline's two ends, then the channel width",
  fibextension: "Click the swing start, the swing end, then the retracement point",
  fibchannel: "Click the baseline's two ends, then the channel width",
  pricerange: "Click the start point, then the end point",
  daterange: "Click the start point, then the end point",
  brush: "Click and drag to draw",
  highlighter: "Click and drag to draw",
};

export function pickTool(tool: ToolDef, setActiveTool: (id: string, hint?: string | null) => void) {
  if (tool.live) {
    setActiveTool(tool.id, PLACEMENT_HINTS[tool.id] ?? null);
    return;
  }
  // Deliberately does NOT call setActiveTool here: arming activeToolId for a
  // tool DrawingLayer doesn't recognize left the rail showing it as "active"
  // (highlighted) while clicking the chart silently did nothing - which
  // reads as the whole drawing system being broken, not just this one tool
  // being unbuilt. Only the status hint changes; the cursor tool stays armed.
  useUiStore.getState().setStatusHint(`${tool.label} isn't built yet - it's marked "Soon" in the tool list`);
}

/** Pure selection logic behind a group's own rail-button click: prefers
 * whichever tool in the group is currently active, then the last live tool
 * explicitly picked from that group, then falls back to the group's first
 * live tool. Exported (and kept side-effect free, no store/DOM access) so
 * it's unit-testable without rendering the rail. */
export function selectDefaultTool(
  group: ToolGroup,
  activeToolId: string | null,
  lastToolByGroup: Record<string, string>,
): ToolDef | undefined {
  return (
    group.tools.find((tl) => tl.id === activeToolId) ??
    // `&& tl.live` here is defensive, not load-bearing under normal use: the
    // only caller (this file's `choose()`) already never records a non-live
    // id into lastToolByGroup. Kept so this function's own contract - "never
    // arms a tool the rail shows as 'Soon'" - holds even if a future caller
    // populates lastToolByGroup some other way.
    group.tools.find((tl) => tl.id === lastToolByGroup[group.id] && tl.live) ??
    group.tools.find((tl) => tl.live)
  );
}

function tooltipFor(tool: ToolDef): string {
  const parts = [tool.label];
  if (TOOL_SHORTCUTS[tool.id]) parts.push(TOOL_SHORTCUTS[tool.id]);
  const first = parts.join(" · ");
  return TOOL_DESCRIPTIONS[tool.id] ? `${first}\n${TOOL_DESCRIPTIONS[tool.id]}` : first;
}

export function LeftToolRail() {
  useToolShortcuts();
  const activeToolId = useUiStore((s) => s.activeToolId);
  const setActiveTool = useUiStore((s) => s.setActiveTool);
  const magnetEnabled = useUiStore((s) => s.magnetEnabled);
  const toggleMagnet = useUiStore((s) => s.toggleMagnet);
  const toolLocked = useUiStore((s) => s.toolLocked);
  const toggleToolLock = useUiStore((s) => s.toggleToolLock);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Remembers the last live tool explicitly picked from each group, so a
  // plain click on the group's rail icon (no flyout needed) re-arms it -
  // matching TradingView, where the icon always acts on click and the
  // flyout is only for switching to a different tool in the group.
  const [lastToolByGroup, setLastToolByGroup] = useState<Record<string, string>>({});

  function renderGroup(group: (typeof TOOL_GROUPS)[number]) {
    const isActiveGroup = group.tools.some((tl) => tl.id === activeToolId);
    const single = group.tools.length === 1;
    const defaultTool = selectDefaultTool(group, activeToolId, lastToolByGroup);

    function choose(tool: ToolDef) {
      pickTool(tool, setActiveTool);
      if (tool.live) setLastToolByGroup((m) => ({ ...m, [group.id]: tool.id }));
    }

    return (
      <div key={group.id} className="rail-group" onMouseEnter={() => !single && setOpenGroup(group.id)}>
        <button
          type="button"
          className={`rail-btn${isActiveGroup ? " active" : ""}`}
          title={single ? group.tools[0].label : `${group.label} (${group.tools.length})`}
          onClick={() => {
            if (single) {
              choose(group.tools[0]);
              return;
            }
            if (defaultTool) choose(defaultTool);
            setOpenGroup((g) => (g === group.id ? null : group.id));
          }}
        >
          <DrawingIcon name={group.id} />
          {!single && <span className="rail-caret">›</span>}
        </button>

        {openGroup === group.id && !single && (
          <div className="rail-flyout">
            <div className="rail-flyout-title">{group.label}</div>
            {group.tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={`rail-flyout-item${tool.id === activeToolId ? " active" : ""}${tool.live ? "" : " reserved"}`}
                title={tool.live ? tooltipFor(tool) : `${tool.label} isn't built yet`}
                onClick={() => {
                  choose(tool);
                  if (tool.live) setOpenGroup(null); // a reserved pick shows a hint, not a placement - keep the flyout open
                }}
              >
                <span className="rail-flyout-main">
                  <DrawingIcon name={tool.id} size={15} />
                  <span className="rail-flyout-label">{tool.label}</span>
                </span>
                {tool.live && TOOL_SHORTCUTS[tool.id] && (
                  <span className="rail-flyout-shortcut">{TOOL_SHORTCUTS[tool.id]}</span>
                )}
                {!tool.live && <span className="reserved-badge">Soon</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Navigation (cursor/crosshair/hand) first, then the magnet toggle right
  // after it - same placement TradingView uses, and deliberately a
  // standalone always-visible button rather than a tool of its own: it's a
  // mode that affects how every OTHER tool places its points, not something
  // you place on the chart.
  const [navGroup, ...restGroups] = TOOL_GROUPS;

  return (
    <div className="rail" onMouseLeave={() => setOpenGroup(null)}>
      {renderGroup(navGroup)}
      <button
        type="button"
        className={`rail-btn${magnetEnabled ? " active" : ""}`}
        title={
          magnetEnabled
            ? "Magnet: on - drawing points snap to the nearest candle open/high/low/close"
            : "Magnet: off - click to snap drawing points to the nearest candle level"
        }
        onClick={toggleMagnet}
      >
        <DrawingIcon name="magnet" />
      </button>
      <button
        type="button"
        className={`rail-btn${toolLocked ? " active" : ""}`}
        title={
          toolLocked
            ? "Stay in tool: on - finishing a drawing re-arms the same tool"
            : "Stay in tool: off - click to keep drawing the same tool repeatedly"
        }
        onClick={toggleToolLock}
      >
        <DrawingIcon name="pin" />
      </button>
      <div className="rail-divider" />
      {restGroups.map(renderGroup)}

      <div className="rail-spacer" />
      <button type="button" className="rail-btn" title="Analysis (SMC lives here, not in the drawing rail)" disabled>
        <DrawingIcon name="analysis" />
      </button>
    </div>
  );
}
