import { beforeEach, describe, expect, it } from "vitest";
import { useOptimizationStore } from "./store";
import type { ParameterDef } from "./types";
import type { PineIndicator } from "../../pine/pineIndicatorStore";

const FLOAT_INPUT_SCRIPT = `//@version=5
indicator("t")
lvl = input.float(0.71, "Fibonacci Entry Level", minval=0.01, maxval=0.99, step=0.01)
plot(lvl)
`;

function indicator(overrides: Partial<PineIndicator> = {}): PineIndicator {
  return { id: "pi-1", name: "test", code: FLOAT_INPUT_SCRIPT, visible: true, inputOverrides: {}, startDate: null, ...overrides };
}

function bars(n: number) {
  return Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 3600, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10 }));
}

function resetStore() {
  useOptimizationStore.setState({
    parameterDefs: [],
    selectedParameterKeys: {},
    run: { status: "idle", progress: null, result: null, error: null, blockedMessage: null },
    lastTradesByCombo: null,
    lastRange: null,
  });
}

describe("useOptimizationStore - parameter discovery + selection", () => {
  beforeEach(resetStore);

  it("discoverParameters populates parameterDefs from the real Pine interpreter and clears any prior selection", () => {
    useOptimizationStore.getState().discoverParameters(indicator(), bars(10));
    const defs = useOptimizationStore.getState().parameterDefs;
    expect(defs).toEqual<ParameterDef[]>([{ key: "lvl", label: "Fibonacci Entry Level", current: 0.71, min: 0.01, max: 0.99, step: 0.01 }]);
    expect(useOptimizationStore.getState().selectedParameterKeys).toEqual({});
  });

  it("toggleParameterSelected flips only the targeted key", () => {
    useOptimizationStore.setState({ parameterDefs: [{ key: "a", label: "A", current: 1, min: 1, max: 1, step: 1 }] });
    const { toggleParameterSelected } = useOptimizationStore.getState();
    toggleParameterSelected("a");
    expect(useOptimizationStore.getState().selectedParameterKeys.a).toBe(true);
    toggleParameterSelected("b");
    expect(useOptimizationStore.getState().selectedParameterKeys).toEqual({ a: true, b: true });
    toggleParameterSelected("a");
    expect(useOptimizationStore.getState().selectedParameterKeys).toEqual({ a: false, b: true });
  });

  it("toggling selection invalidates any existing run result", () => {
    useOptimizationStore.setState({
      parameterDefs: [{ key: "a", label: "A", current: 1, min: 1, max: 1, step: 1 }],
      run: { status: "done", progress: null, result: {} as never, error: null, blockedMessage: null },
    });
    useOptimizationStore.getState().toggleParameterSelected("a");
    expect(useOptimizationStore.getState().run.status).toBe("idle");
  });
});

describe("useOptimizationStore - runOptimization validation", () => {
  beforeEach(resetStore);

  it("blocks with 'Select at least one parameter to optimize.' when parameters were discovered but none are checked", async () => {
    useOptimizationStore.setState({
      parameterDefs: [{ key: "fiboEntryLevel", label: "Fibonacci Entry Level", current: 0.71, min: 0.01, max: 0.99, step: 0.01 }],
      selectedParameterKeys: {},
    });
    await useOptimizationStore.getState().runOptimization(indicator(), ["EURUSD"]);
    expect(useOptimizationStore.getState().run.status).toBe("blocked");
    expect(useOptimizationStore.getState().run.blockedMessage).toBe("Select at least one parameter to optimize.");
  });

  it("does NOT show the selection-validation message when zero parameters were ever discovered (baseline-only run is still valid)", async () => {
    useOptimizationStore.setState({ parameterDefs: [], selectedParameterKeys: {} });
    // No indicator code capable of producing trades on empty bars - this
    // only asserts the validation branch is skipped, not the full run.
    const promise = useOptimizationStore.getState().runOptimization(indicator(), []);
    await promise;
    expect(useOptimizationStore.getState().run.blockedMessage).not.toBe("Select at least one parameter to optimize.");
  });
});
