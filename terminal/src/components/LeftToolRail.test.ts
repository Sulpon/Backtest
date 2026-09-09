import { describe, expect, it, beforeEach } from "vitest";
import { pickTool, selectDefaultTool } from "./LeftToolRail";
import { TOOL_GROUPS } from "./toolDefinitions";
import { useUiStore } from "../workspace/uiStore";

/**
 * Pure-logic coverage for the rail's group/tool-selection behavior
 * (selectDefaultTool) and the live-vs-"Soon" arming split (pickTool).
 * Deliberately does NOT render <LeftToolRail> - this repo has no React
 * Testing Library/jsdom setup yet (see vite.config.ts's own comment), so
 * component rendering/interaction isn't testable here. Both functions
 * under test are already extracted as side-effect-minimal, exported
 * functions specifically so this logic doesn't need a DOM to verify.
 */

const linesGroup = TOOL_GROUPS.find((g) => g.id === "lines")!;
const fibonacciGroup = TOOL_GROUPS.find((g) => g.id === "fibonacci")!;

describe("selectDefaultTool", () => {
  it("prefers the group's currently active tool over anything else", () => {
    const picked = selectDefaultTool(linesGroup, "hline", { lines: "trendline" });
    expect(picked?.id).toBe("hline");
  });

  it("falls back to the last tool explicitly picked from the group when nothing in it is active", () => {
    const picked = selectDefaultTool(linesGroup, "cursor", { lines: "ray" });
    expect(picked?.id).toBe("ray");
  });

  it("falls back to the group's first live tool when there's no active or remembered tool", () => {
    // "infoline" (first in the array) is not live - trendline is the first live one.
    const picked = selectDefaultTool(linesGroup, "cursor", {});
    expect(picked?.id).toBe("trendline");
    expect(picked?.live).toBe(true);
  });

  it("never returns a non-live tool as the fallback default, even if remembered", () => {
    // A non-live id can't actually get into lastToolByGroup via the rail's own
    // `choose()` (it only records live picks) - this guards the invariant
    // directly against selectDefaultTool itself, independent of that caller.
    const picked = selectDefaultTool(fibonacciGroup, "cursor", { fibonacci: "fibtimezone" });
    expect(picked?.id).not.toBe("fibtimezone");
    expect(picked?.live).toBe(true);
  });

  it("returns undefined for a group with no live tools at all", () => {
    const allReserved = { id: "empty", label: "Empty", tools: fibonacciGroup.tools.filter((t) => !t.live) };
    const picked = selectDefaultTool(allReserved, "cursor", {});
    expect(picked).toBeUndefined();
  });
});

describe("pickTool", () => {
  beforeEach(() => {
    useUiStore.setState({ activeToolId: "cursor", statusHint: null });
  });

  it("arms a live tool via setActiveTool with its placement hint", () => {
    const calls: Array<[string, string | null | undefined]> = [];
    const tool = TOOL_GROUPS.flatMap((g) => g.tools).find((t) => t.id === "trendline")!;
    pickTool(tool, (id, hint) => calls.push([id, hint]));
    expect(calls).toEqual([["trendline", "Click the first point, then the second"]]);
  });

  it("does NOT arm a non-live tool - only sets a status hint, activeToolId is left alone", () => {
    const calls: Array<[string, string | null | undefined]> = [];
    const tool = TOOL_GROUPS.flatMap((g) => g.tools).find((t) => t.id === "polyline")!;
    expect(tool.live).toBe(false);
    pickTool(tool, (id, hint) => calls.push([id, hint]));
    expect(calls).toEqual([]);
    expect(useUiStore.getState().statusHint).toMatch(/isn't built yet/);
    expect(useUiStore.getState().activeToolId).toBe("cursor");
  });
});
