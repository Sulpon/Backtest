import { beforeEach, describe, expect, it } from "vitest";
import { toggleLegendIndicator } from "./indicatorLegend";
import { useIndicatorStore } from "../indicators/indicatorStore";
import { useCustomIndicatorStore } from "../indicators/customIndicatorStore";
import { usePineIndicatorStore } from "../pine/pineIndicatorStore";

// toggleLegendIndicator is the on-chart legend chip's click handler (see
// ChartPane.tsx's indicatorLegend chips) - it dispatches by the
// `builtin-`/`custom-`/`pine-` id prefix to the matching store's own
// toggleVisible action. Asserted against real store state (rather than
// mocking each store's toggleVisible) because zustand's setState merges by
// spreading the previous state object, which would otherwise carry a
// mocked function forward into every later state update within a test file.
describe("toggleLegendIndicator", () => {
  beforeEach(() => {
    useIndicatorStore.setState({ active: [] });
    useCustomIndicatorStore.setState({ items: [] });
    usePineIndicatorStore.setState({ items: [] });
  });

  it("toggles the built-in indicator store for a builtin- prefixed id", () => {
    useIndicatorStore.getState().add("sma", 20);
    const id = useIndicatorStore.getState().active[0].id;

    toggleLegendIndicator(`builtin-${id}`);

    expect(useIndicatorStore.getState().active[0].visible).toBe(false);
  });

  it("toggles the custom indicator store for a custom- prefixed id", () => {
    useCustomIndicatorStore.getState().add("My Custom", "return [];");
    const id = useCustomIndicatorStore.getState().items[0].id;

    toggleLegendIndicator(`custom-${id}`);

    expect(useCustomIndicatorStore.getState().items[0].visible).toBe(false);
  });

  it("toggles the pine indicator store for a pine- prefixed id", () => {
    const id = usePineIndicatorStore.getState().add("My Script", "//@version=5");

    toggleLegendIndicator(`pine-${id}`);

    expect(usePineIndicatorStore.getState().items[0].visible).toBe(false);
  });

  it("does nothing for an id with no recognized prefix", () => {
    useIndicatorStore.getState().add("sma", 20);
    useCustomIndicatorStore.getState().add("My Custom", "return [];");
    usePineIndicatorStore.getState().add("My Script", "//@version=5");

    toggleLegendIndicator("unknown-1");

    expect(useIndicatorStore.getState().active[0].visible).toBe(true);
    expect(useCustomIndicatorStore.getState().items[0].visible).toBe(true);
    expect(usePineIndicatorStore.getState().items[0].visible).toBe(true);
  });
});
