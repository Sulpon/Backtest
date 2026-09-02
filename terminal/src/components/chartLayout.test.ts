import { describe, expect, it } from "vitest";
import {
  applyChartLayout,
  computeChartLayoutPlan,
  countChartPanels,
  isChartPanelId,
  timeframeForPaneIndex,
  type ChartLayoutDockviewApi,
} from "./chartLayout";
import { TIMEFRAMES } from "../data/timeframes";
import type { Timeframe } from "../data/types";

/** Minimal in-memory stand-in for dockview's DockviewApi, exercising exactly
 * the surface applyChartLayout uses (panels/getPanel/addPanel/removePanel)
 * so these tests prove the real add/remove call sequence works, not just the
 * pure plan. */
class FakeDockviewApi implements ChartLayoutDockviewApi {
  panelsById = new Map<string, { id: string; params?: { symbol: string; timeframe: Timeframe } }>();
  addCalls: { id: string; referencePanel: string; direction: string }[] = [];

  get panels() {
    return Array.from(this.panelsById.values());
  }
  getPanel(id: string) {
    return this.panelsById.get(id);
  }
  removePanel(panel: { id: string }) {
    this.panelsById.delete(panel.id);
  }
  addPanel(options: {
    id: string;
    component: string;
    title: string;
    params: { symbol: string; timeframe: Timeframe };
    position: { referencePanel: string; direction: "right" | "below" };
  }) {
    // Real dockview would throw/no-op for a reference panel that doesn't
    // exist yet - asserting it here catches an ordering bug in the planner.
    if (!this.panelsById.has(options.position.referencePanel)) {
      throw new Error(`addPanel(${options.id}): reference panel ${options.position.referencePanel} doesn't exist yet`);
    }
    this.panelsById.set(options.id, { id: options.id, params: options.params });
    this.addCalls.push({ id: options.id, referencePanel: options.position.referencePanel, direction: options.position.direction });
  }
}

function seededApi(): FakeDockviewApi {
  const api = new FakeDockviewApi();
  api.panelsById.set("chart-1", { id: "chart-1", params: { symbol: "EURUSD", timeframe: "1h" } });
  return api;
}

describe("isChartPanelId", () => {
  it("matches chart-<n> ids and rejects everything else", () => {
    expect(isChartPanelId("chart-1")).toBe(true);
    expect(isChartPanelId("chart-16")).toBe(true);
    expect(isChartPanelId("watchlist-1")).toBe(false);
    expect(isChartPanelId("chart-")).toBe(false);
    expect(isChartPanelId("trades-1")).toBe(false);
  });
});

describe("timeframeForPaneIndex", () => {
  it("pane 1 is the starting timeframe itself", () => {
    expect(timeframeForPaneIndex("1h", 1)).toBe("1h");
  });

  it("cycles forward through TIMEFRAMES for later panes", () => {
    const start = TIMEFRAMES.indexOf("1h");
    expect(timeframeForPaneIndex("1h", 2)).toBe(TIMEFRAMES[(start + 1) % TIMEFRAMES.length]);
    expect(timeframeForPaneIndex("1h", 3)).toBe(TIMEFRAMES[(start + 2) % TIMEFRAMES.length]);
  });

  it("wraps around with modulo once past the end of TIMEFRAMES (16-pane case)", () => {
    // TIMEFRAMES has 7 entries - pane 9 (index 9) should wrap back around.
    const start = TIMEFRAMES.indexOf("1h");
    const expected = TIMEFRAMES[(start + 15) % TIMEFRAMES.length];
    expect(timeframeForPaneIndex("1h", 16)).toBe(expected);
    // never throws / never returns undefined for any pane up to 16
    for (let i = 1; i <= 16; i++) {
      expect(TIMEFRAMES).toContain(timeframeForPaneIndex("1h", i));
    }
  });
});

describe("computeChartLayoutPlan", () => {
  it("adding from 1 to 4 panes plans 3 additions positioned as a 2-column grid", () => {
    const plan = computeChartLayoutPlan(["chart-1"], 4, "EURUSD", "1h");
    expect(plan.toRemove).toEqual([]);
    expect(plan.toAdd.map((a) => a.id)).toEqual(["chart-2", "chart-3", "chart-4"]);
    expect(plan.toAdd[0]).toMatchObject({ referencePanelId: "chart-1", direction: "right" });
    expect(plan.toAdd[1]).toMatchObject({ referencePanelId: "chart-1", direction: "below" });
    expect(plan.toAdd[2]).toMatchObject({ referencePanelId: "chart-2", direction: "below" });
  });

  it("every addition defaults to the given symbol", () => {
    const plan = computeChartLayoutPlan(["chart-1"], 4, "GBPUSD", "1h");
    expect(plan.toAdd.every((a) => a.symbol === "GBPUSD")).toBe(true);
  });

  it("shrinking from 8 to 2 removes chart-3..chart-8 and adds nothing", () => {
    const currentIds = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`);
    const plan = computeChartLayoutPlan(currentIds, 2, "EURUSD", "1h");
    expect(plan.toAdd).toEqual([]);
    expect(new Set(plan.toRemove)).toEqual(new Set(["chart-3", "chart-4", "chart-5", "chart-6", "chart-7", "chart-8"]));
  });

  it("16-pane plan produces 15 additions with a deterministic 2-column grid all the way through", () => {
    const plan = computeChartLayoutPlan(["chart-1"], 16, "EURUSD", "1h");
    expect(plan.toAdd).toHaveLength(15);
    expect(plan.toAdd.map((a) => a.id)).toEqual(Array.from({ length: 15 }, (_, i) => `chart-${i + 2}`));
    // pane 5 goes below pane 3, pane 16 goes below pane 14 - the "reference
    // two slots back" rule extended all the way out.
    expect(plan.toAdd.find((a) => a.id === "chart-5")).toMatchObject({ referencePanelId: "chart-3", direction: "below" });
    expect(plan.toAdd.find((a) => a.id === "chart-16")).toMatchObject({ referencePanelId: "chart-14", direction: "below" });
  });
});

describe("applyChartLayout", () => {
  it("clicking 4 actually results in 4 chart panels existing", () => {
    const api = seededApi();
    const result = applyChartLayout(api, 4, "EURUSD", "1h");
    expect(result).toBe(4);
    expect(api.panels.map((p) => p.id).filter(isChartPanelId).sort()).toEqual(["chart-1", "chart-2", "chart-3", "chart-4"]);
  });

  it("adds panels in an order where every reference panel already exists (no throw)", () => {
    const api = seededApi();
    expect(() => applyChartLayout(api, 16, "EURUSD", "1h")).not.toThrow();
    expect(countChartPanels(api)).toBe(16);
  });

  it("newly added panes get displaySymbol and the expected cycling timeframe", () => {
    const api = seededApi();
    applyChartLayout(api, 4, "EURUSD", "1h");
    const start = TIMEFRAMES.indexOf("1h");
    expect(api.getPanel("chart-2")?.params).toEqual({ symbol: "EURUSD", timeframe: TIMEFRAMES[(start + 1) % TIMEFRAMES.length] });
    expect(api.getPanel("chart-3")?.params).toEqual({ symbol: "EURUSD", timeframe: TIMEFRAMES[(start + 2) % TIMEFRAMES.length] });
    expect(api.getPanel("chart-4")?.params).toEqual({ symbol: "EURUSD", timeframe: TIMEFRAMES[(start + 3) % TIMEFRAMES.length] });
  });

  it("clicking 8 then 2 correctly removes the extra panels down to 2", () => {
    const api = seededApi();
    applyChartLayout(api, 8, "EURUSD", "1h");
    expect(countChartPanels(api)).toBe(8);

    const result = applyChartLayout(api, 2, "EURUSD", "1h");
    expect(result).toBe(2);
    expect(api.panels.map((p) => p.id).filter(isChartPanelId).sort()).toEqual(["chart-1", "chart-2"]);
  });

  it("going 1 -> 2 -> 1 leaves only chart-1, matching the pre-existing single-pane behavior", () => {
    const api = seededApi();
    applyChartLayout(api, 2, "EURUSD", "1h");
    const result = applyChartLayout(api, 1, "EURUSD", "1h");
    expect(result).toBe(1);
    expect(api.panels.map((p) => p.id).filter(isChartPanelId)).toEqual(["chart-1"]);
  });

  it("is idempotent: applying the same target count twice adds/removes nothing further", () => {
    const api = seededApi();
    applyChartLayout(api, 4, "EURUSD", "1h");
    const beforeCalls = api.addCalls.length;
    const result = applyChartLayout(api, 4, "EURUSD", "1h");
    expect(result).toBe(4);
    expect(api.addCalls.length).toBe(beforeCalls);
  });
});

describe("countChartPanels", () => {
  it("returns 1 when there's no api yet (chart-1 is always seeded before any interaction is possible)", () => {
    expect(countChartPanels(null)).toBe(1);
  });

  it("reflects the live panel count", () => {
    const api = seededApi();
    applyChartLayout(api, 4, "EURUSD", "1h");
    expect(countChartPanels(api)).toBe(4);
  });
});
