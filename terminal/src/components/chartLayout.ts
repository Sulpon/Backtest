import type { Timeframe } from "../data/types";
import { TIMEFRAMES, TIMEFRAME_LABELS } from "../data/timeframes";

/**
 * Generalized N-pane chart layout logic backing the top toolbar's 1/2/4/8/16
 * layout picker (and, via applyChartLayout, the command palette's
 * view:splitPane/view:collapsePane commands - see commandPalette/commands.ts).
 *
 * Chart panel ids are always "chart-<n>" (1-based, contiguous from 1) - the
 * convention every chart-panel consumer in this app already relies on
 * (ChartPane's isPrimary check, DockviewRoot's seedLayout). Matching on this
 * id shape - rather than dockview's internal component bookkeeping, which
 * isn't exposed on IDockviewPanel - is how chart panes are told apart from
 * watchlist-1/trades-1/stats-1 etc.
 *
 * The pure planning function (computeChartLayoutPlan) assumes the existing
 * set of chart panels is contiguous chart-1..chart-N with no gaps, and that
 * chart-1 is never removed. That invariant holds as long as applyChartLayout
 * (or logic that mirrors it exactly) is the only thing that adds/removes
 * numbered chart panels - which is why command palette's split/collapse
 * commands should route through applyChartLayout too, rather than poking
 * chart-2 in isolation.
 */

const CHART_PANEL_ID_RE = /^chart-(\d+)$/;

export function isChartPanelId(id: string): boolean {
  return CHART_PANEL_ID_RE.test(id);
}

function chartPanelIndex(id: string): number | null {
  const m = CHART_PANEL_ID_RE.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * Where a newly-added pane docks, building a 2-column grid rather than one
 * long cascading row: pane 2 goes to the right of chart-1; every pane after
 * that goes below the pane two slots back (chart-(index-2)), so odd-numbered
 * panes stack into a left column and even-numbered panes stack into a right
 * column. Not a perfect square for large N, but usable and deterministic -
 * e.g. for 16 panes this produces an 8-row x 2-column grid.
 */
function positionForPane(index: number): { referencePanelId: string; direction: "right" | "below" } {
  if (index === 2) return { referencePanelId: "chart-1", direction: "right" };
  return { referencePanelId: `chart-${index - 2}`, direction: "below" };
}

/**
 * Timeframe assigned to newly-added pane `index` (1-based; index 1 is
 * chart-1 itself and is never touched here - it keeps whatever it's already
 * showing): cycles forward through TIMEFRAMES starting at displayTimeframe's
 * own slot, wrapping with modulo so a 16-pane layout (more panes than the 7
 * known timeframes) still gets a deterministic, non-crashing assignment
 * instead of running out partway through. Pane 2 gets the timeframe right
 * after displayTimeframe, pane 3 the one after that, etc., wrapping back to
 * the start of TIMEFRAMES once exhausted.
 */
export function timeframeForPaneIndex(displayTimeframe: Timeframe, index: number): Timeframe {
  const start = TIMEFRAMES.indexOf(displayTimeframe);
  const safeStart = start === -1 ? 0 : start;
  const offset = (safeStart + (index - 1)) % TIMEFRAMES.length;
  return TIMEFRAMES[offset];
}

export interface ChartPanelAddition {
  id: string;
  index: number;
  symbol: string;
  timeframe: Timeframe;
  referencePanelId: string;
  direction: "right" | "below";
}

export interface ChartLayoutPlan {
  /** ids to remove, highest index first (order doesn't matter functionally,
   * but removing from the top down keeps the "reference panel already
   * exists" invariant trivially true even if this were ever reordered). */
  toRemove: string[];
  /** additions in ascending index order - callers MUST add them in this
   * order, since pane `index`'s reference panel (chart-(index-2)) may itself
   * be one of the earlier entries in this same list. */
  toAdd: ChartPanelAddition[];
}

/** Pure planning step (no dockview dependency) - given the ids of whichever
 * chart panels currently exist and a target pane count, works out which to
 * remove and which to add, with each addition's default symbol/timeframe/
 * position already resolved. */
export function computeChartLayoutPlan(
  currentChartIds: string[],
  targetCount: number,
  displaySymbol: string,
  displayTimeframe: Timeframe
): ChartLayoutPlan {
  const currentIndices = currentChartIds.map(chartPanelIndex).filter((n): n is number => n !== null);
  const currentCount = currentIndices.length ? Math.max(...currentIndices) : 0;

  const toRemove = currentIndices
    .filter((idx) => idx > targetCount)
    .sort((a, b) => b - a)
    .map((idx) => `chart-${idx}`);

  const toAdd: ChartPanelAddition[] = [];
  for (let idx = currentCount + 1; idx <= targetCount; idx++) {
    const { referencePanelId, direction } = positionForPane(idx);
    toAdd.push({
      id: `chart-${idx}`,
      index: idx,
      symbol: displaySymbol,
      timeframe: timeframeForPaneIndex(displayTimeframe, idx),
      referencePanelId,
      direction,
    });
  }

  return { toRemove, toAdd };
}

/** Minimal surface of dockview-react's DockviewApi this module needs - kept
 * narrow so tests can pass a plain fake without pulling in real dockview
 * internals. The real DockviewApi satisfies this structurally. */
export interface ChartLayoutDockviewApi {
  readonly panels: { id: string }[];
  getPanel(id: string): { id: string } | undefined;
  removePanel(panel: { id: string }): void;
  addPanel(options: {
    id: string;
    component: string;
    title: string;
    params: { symbol: string; timeframe: Timeframe };
    position: { referencePanel: string; direction: "right" | "below" };
  }): unknown;
}

/** Drives dockview to the target chart-pane count, applying the plan above.
 * Returns the resulting chart-pane count read back from the api (rather than
 * just trusting `targetCount`), so a caller can resync UI state from what
 * actually happened, not merely what was requested. */
export function applyChartLayout(
  api: ChartLayoutDockviewApi,
  targetCount: number,
  displaySymbol: string,
  displayTimeframe: Timeframe
): number {
  const currentChartIds = api.panels.map((p) => p.id).filter(isChartPanelId);
  const plan = computeChartLayoutPlan(currentChartIds, targetCount, displaySymbol, displayTimeframe);

  for (const id of plan.toRemove) {
    const panel = api.getPanel(id);
    if (panel) api.removePanel(panel);
  }
  for (const addition of plan.toAdd) {
    api.addPanel({
      id: addition.id,
      component: "chart",
      title: `${addition.symbol} · ${TIMEFRAME_LABELS[addition.timeframe]}`,
      params: { symbol: addition.symbol, timeframe: addition.timeframe },
      position: { referencePanel: addition.referencePanelId, direction: addition.direction },
    });
  }

  return api.panels.map((p) => p.id).filter(isChartPanelId).length;
}

/** Current chart-pane count, straight from the dockview api - used to derive
 * the layout picker's highlighted button from reality instead of an
 * optimistic local guess. Defaults to 1 when there's no api yet (matches
 * chart-1 always being seeded before any user interaction is possible). */
export function countChartPanels(api: ChartLayoutDockviewApi | null): number {
  if (!api) return 1;
  const count = api.panels.map((p) => p.id).filter(isChartPanelId).length;
  return count || 1;
}
