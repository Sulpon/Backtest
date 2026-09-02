import { useIndicatorStore } from "../indicators/indicatorStore";
import { useCustomIndicatorStore } from "../indicators/customIndicatorStore";
import { usePineIndicatorStore } from "../pine/pineIndicatorStore";

// Split out of ChartPane.tsx so this dispatch logic can be unit-tested
// without importing ChartPane.tsx itself - ChartPane transitively pulls in
// DrawingLayer's module-scope `window.addEventListener` calls
// (src/drawing/interactionState.ts), which this repo's vitest setup can't
// run (pure-logic/node environment only, no jsdom - see vite.config.ts).
// This module only touches the three indicator stores, which have no such
// browser-global dependency at import time.
//
// The on-chart indicator legend's chips are prefixed by which store owns
// them (`builtin-`/`custom-`/`pine-`, set when ChartPane's indicatorLegend
// array is built) - this dispatches a click to the right store's own
// toggleVisible action.
export function toggleLegendIndicator(id: string) {
  if (id.startsWith("builtin-")) useIndicatorStore.getState().toggleVisible(id.slice("builtin-".length));
  else if (id.startsWith("custom-")) useCustomIndicatorStore.getState().toggleVisible(id.slice("custom-".length));
  else if (id.startsWith("pine-")) usePineIndicatorStore.getState().toggleVisible(id.slice("pine-".length));
}
