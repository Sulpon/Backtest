/**
 * The default "last N bars" visible-range window a freshly-loaded chart
 * pane opens on. Extracted as a pure function (rather than left inline in
 * ChartPane.tsx) specifically so this bounds computation is unit-testable
 * without importing ChartPane.tsx itself, which transitively pulls in
 * src/drawing/interactionState.ts's module-scope `window.addEventListener`
 * call that this repo's vitest config (pure-logic/node environment, no
 * jsdom) can't execute - same reasoning as indicatorLegend.ts's own split.
 *
 * Returns null for zero bars - a pane can legitimately have no data (e.g.
 * production only serves 1h/4h/1d, see export_deploy_db.py, so a pane
 * assigned 1m/5m/15m/30m there gets an empty dataset), and there's no
 * meaningful visible range to set for it. Confirmed the hard way: the
 * inline version of this before extraction indexed bars[from]/bars[last]
 * unconditionally, so an empty array crashed the whole chart pane - with
 * no error boundary above it, into a blank/black screen (16-pane layout
 * make this a real, reachable state on the deployed site, not a
 * theoretical one).
 */
export function defaultVisibleRangeIndices(barsLength: number, windowSize = 300): { from: number; to: number } | null {
  const last = barsLength - 1;
  if (last < 0) return null;
  const from = Math.max(0, last - windowSize);
  return { from, to: last };
}
