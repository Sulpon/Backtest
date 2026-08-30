import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { Interpreter, type Bar } from "./interpreter";
import { buildStdlib } from "./stdlib";

/**
 * Regression tests for the Phase 1 interpreter optimizations (identCache,
 * callCache, resolveArgs hidden-class stability, eager line/box/label
 * deletion) - see terminal/README.md#performance for the profiling report
 * these were built from. Every test here targets one of those specific
 * code paths and asserts an EXACT expected value, not just "it ran" - the
 * whole point of these caches is that they must be invisible to output.
 */

function bars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1000 + i * 3600,
    open: 1 + i * 0.01,
    high: 1.5 + i * 0.01,
    low: 0.5 + i * 0.01,
    close: 1.2 + i * 0.01,
    volume: 10 + i,
  }));
}

function run(code: string, n: number, inputOverrides: Record<string, unknown> = {}) {
  const stdlib = buildStdlib();
  const ast = parse(tokenize(code));
  const interp = new Interpreter(ast, bars(n), stdlib, inputOverrides);
  const outputs = interp.run();
  return { ...outputs, inputDefs: interp.inputDefs };
}

describe("identCache - plain identifier reads across bars", () => {
  it("a global var's value is correct on every bar, not just the first read", () => {
    const out = run(
      `//@version=5
indicator("t")
x = close * 2
plot(x)
`,
      5
    );
    expect(out.plots[0].points.map((p) => p.value)).toEqual([2.4, 2.42, 2.44, 2.46, 2.48]);
  });

  it("a reassigned (:=) variable reflects the LATEST value, not a cached stale one", () => {
    const out = run(
      `//@version=5
indicator("t")
var acc = 0.0
acc := acc + close
plot(acc)
`,
      4
    );
    // cumulative sum of close = 1.2, 1.2+1.21, +1.22, +1.23
    expect(out.plots[0].points.map((p) => Number(p.value.toFixed(4)))).toEqual([1.2, 2.41, 3.63, 4.86]);
  });
});

describe("identCache - history reference [] across bars", () => {
  it("close[1] correctly lags by exactly one bar, every bar", () => {
    const out = run(
      `//@version=5
indicator("t")
plot(close[1])
`,
      4
    );
    // bar 0 has no prior bar -> NA (filtered out of plots, so points start at bar 1)
    expect(out.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([1.2, 1.21, 1.22]);
  });

  it("a user-declared variable's history[] lookback resolves to the same binding every bar", () => {
    const out = run(
      `//@version=5
indicator("t")
x = close
plot(x - x[2])
`,
      5
    );
    // x[2] two bars back; close increments by 0.01/bar, so x - x[2] = 0.02 from bar 2 onward
    const vals = out.plots[0].points.map((p) => Number(p.value.toFixed(4)));
    expect(vals).toEqual([0.02, 0.02, 0.02]);
  });
});

describe("callCache - user function calls", () => {
  it("a user function called every bar returns a fresh, correct result each time", () => {
    const out = run(
      `//@version=5
indicator("t")
double(v) =>
    v * 2
plot(double(close))
`,
      3
    );
    expect(out.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([2.4, 2.42, 2.44]);
  });

  it("a recursive-looking repeated call sequence still resolves correctly (same fn.scope reused)", () => {
    const out = run(
      `//@version=5
indicator("t")
addOne(v) =>
    v + 1
a = addOne(close)
b = addOne(a)
plot(b)
`,
      3
    );
    expect(out.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([3.2, 3.21, 3.22]);
  });
});

describe("callCache - stdlib global and namespace calls", () => {
  it("a stdlib global function (math.max) is dispatched and computed correctly every bar", () => {
    const out = run(
      `//@version=5
indicator("t")
plot(math.max(close, open))
`,
      3
    );
    expect(out.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([1.2, 1.21, 1.22]);
  });

  it("input() returns the SAME value on every bar (resolved once on bar 0, cached)", () => {
    const out = run(
      `//@version=5
indicator("t")
len = input.int(20, "Length")
plot(len)
`,
      5
    );
    expect(out.plots[0].points.map((p) => p.value)).toEqual([20, 20, 20, 20, 20]);
    expect(out.inputDefs[0]).toMatchObject({ key: "len", kind: "int", defaultValue: 20 });
  });

  it("an input override is honored identically to before (input() caching doesn't bypass overrides)", () => {
    const out = run(
      `//@version=5
indicator("t")
len = input.int(20, "Length")
plot(len)
`,
      3,
      { len: 55 }
    );
    expect(out.plots[0].points.map((p) => p.value)).toEqual([55, 55, 55]);
  });
});

describe("callCache - callRaw (ta.highest/lowest lookback)", () => {
  it("ta.highest computes the correct rolling max every bar", () => {
    const out = run(
      `//@version=5
indicator("t")
plot(ta.highest(high, 3))
`,
      5
    );
    // high = 1.5, 1.51, 1.52, 1.53, 1.54 - rolling max of the trailing 3
    const vals = out.plots[0].points.map((p) => Number(p.value.toFixed(2)));
    expect(vals).toEqual([1.5, 1.51, 1.52, 1.53, 1.54]);
  });
});

describe("eager line/box/label deletion", () => {
  it("a deleted line never appears in output, and the registry no longer holds it", () => {
    const out = run(
      `//@version=5
indicator("t")
if bar_index == 0
    l = line.new(bar_index, close, bar_index + 1, close)
    line.delete(l)
`,
      2
    );
    expect(out.lines).toEqual([]);
  });

  it("a redraw-every-bar pattern (delete old, draw new) only ever outputs the LAST one", () => {
    const out = run(
      `//@version=5
indicator("t")
var line l = na
if not na(l)
    line.delete(l)
l := line.new(bar_index, close, bar_index, close)
`,
      5
    );
    expect(out.lines.length).toBe(1);
  });

  it("delete_line (the d.* wrapper) removes both the line and its paired label", () => {
    const out = run(
      `//@version=5
indicator("t")
import someuser/Drawings_public/1 as d
if bar_index == 0
    l = line.new(bar_index, close, bar_index + 1, close)
    lbl = label.new(bar_index, close, "x")
    d.delete_line(l, lbl)
`,
      2
    );
    expect(out.lines).toEqual([]);
    expect(out.labels).toEqual([]);
  });

  it("boxes and labels are deleted the same way as lines", () => {
    const out = run(
      `//@version=5
indicator("t")
if bar_index == 0
    b = box.new(bar_index, high, bar_index + 1, low)
    box.delete(b)
    lbl = label.new(bar_index, close, "x")
    label.delete(lbl)
`,
      2
    );
    expect(out.boxes).toEqual([]);
    expect(out.labels).toEqual([]);
  });

  it("a NON-deleted line/box/label still survives to output normally", () => {
    const out = run(
      `//@version=5
indicator("t")
if bar_index == 0
    line.new(bar_index, close, bar_index + 1, close)
    box.new(bar_index, high, bar_index + 1, low)
    label.new(bar_index, close, "x")
`,
      2
    );
    expect(out.lines.length).toBe(1);
    expect(out.boxes.length).toBe(1);
    expect(out.labels.length).toBe(1);
  });
});

describe("Phase 2 - reused ResolvedArgs object and shared BuiltinCtx (resolveArgs/ctx allocation optimization)", () => {
  it("a stdlib call inside a loop gets the CURRENT iteration's value every time, not a stale value from a previous iteration/bar (resolveArgs output-object reuse)", () => {
    const out = run(
      `//@version=5
indicator("t")
var float acc = 0.0
for i = 0 to 2
    acc := math.max(acc, close + i)
plot(acc)
`,
      3
    );
    // bar0 (close=1.2): i=0 -> max(0,1.2)=1.2, i=1 -> max(1.2,2.2)=2.2, i=2 -> max(2.2,3.2)=3.2
    // bar1 (close=1.21, acc carried in at 3.2): i=2 -> close+i=3.21 > 3.2 -> acc becomes 3.21
    // bar2 (close=1.22, acc carried in at 3.21): i=2 -> close+i=3.22 > 3.21 -> acc becomes 3.22
    const vals = out.plots[0].points.map((p) => Number(p.value.toFixed(2)));
    expect(vals).toEqual([3.2, 3.21, 3.22]);
  });

  it("two DIFFERENT call sites to the same stdlib function never cross-contaminate each other's cached ResolvedArgs object", () => {
    const out = run(
      `//@version=5
indicator("t")
a = math.max(close, 0)
b = math.max(open, 100)
plot(a, title="a")
plot(b, title="b")
`,
      3
    );
    expect(out.plots.find((p) => p.name === "a")!.points.map((p) => Number(p.value.toFixed(2)))).toEqual([1.2, 1.21, 1.22]);
    expect(out.plots.find((p) => p.name === "b")!.points.map((p) => p.value)).toEqual([100, 100, 100]);
  });

  it("an optional (unsupplied) stdlib param stays na/undefined-equivalent on every bar, not just the first (no stale leakage into a reused args object)", () => {
    const out = run(
      `//@version=5
indicator("t")
l = label.new(bar_index, close, "x")
plot(bar_index)
`,
      3
    );
    // label.new's unsupplied optional params (e.g. color/style overrides)
    // must resolve identically every bar - if a reused ResolvedArgs object
    // ever leaked a stale value into an unsupplied slot, this would surface
    // as a changed label field on a later bar. A new label is created every
    // bar here (no `var`/guard), so 3 bars -> 3 registered labels, all with
    // the same (default) style/color.
    expect(out.labels.length).toBe(3);
    const styles = new Set(out.labels.map((l) => l.style));
    const colors = new Set(out.labels.map((l) => l.color));
    expect(styles.size).toBe(1);
    expect(colors.size).toBe(1);
    expect(out.plots[0].points.length).toBe(3);
  });

  it("plot()'s per-bar time (read via the shared/reused BuiltinCtx.bar) tracks the CURRENT bar every call, not a stale bar from a previous call", () => {
    const out = run(
      `//@version=5
indicator("t")
plot(close)
`,
      4
    );
    const times = out.plots[0].points.map((p) => p.time);
    // Bar times from the bars(n) helper are 1000 + i*3600 (raw seconds, as
    // given in Bar.time - plot() doesn't rescale it).
    expect(times).toEqual([1000, 4600, 8200, 11800]);
  });
});

describe("multiple interpreter instances sharing the same parsed AST", () => {
  it("each instance's identCache/callCache is independent - no cross-run contamination", () => {
    const stdlib = buildStdlib();
    const ast = parse(
      tokenize(`//@version=5
indicator("t")
plot(close * 2)
`)
    );
    const interp1 = new Interpreter(ast, bars(3), stdlib, {});
    const out1 = interp1.run();
    // A second interpreter over DIFFERENT bars, reusing the SAME ast object -
    // exactly what happens if an ast were ever reused across runs (not
    // currently done in this app, but the cache design must not assume
    // otherwise).
    const interp2 = new Interpreter(ast, bars(3).map((b) => ({ ...b, close: b.close + 100 })), stdlib, {});
    const out2 = interp2.run();

    expect(out1.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([2.4, 2.42, 2.44]);
    expect(out2.plots[0].points.map((p) => Number(p.value.toFixed(2)))).toEqual([202.4, 202.42, 202.44]);
  });
});
