import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { Interpreter, type Bar } from "./interpreter";
import { buildStdlib } from "./stdlib";
import { runCompiled } from "./compiler";

/**
 * Regression tests for the Phase 2 AST compiler (compiler.ts) - see
 * terminal/README.md#performance for the profiling report and measured
 * benchmark this was built from. Every test runs the SAME script through
 * BOTH the Phase-1 interpreter (`interp.run()`) and the compiler
 * (`runCompiled(interp)`) and asserts the two outputs are byte-identical
 * (`JSON.stringify` equality of the full PineOutputs) - not just that the
 * compiled path "ran without throwing". That's the actual correctness bar
 * this compiler has to clear: it must be behaviorally invisible.
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

function compareInterpretedVsCompiled(code: string, n: number, inputOverrides: Record<string, unknown> = {}) {
  const stdlib = buildStdlib();
  const b = bars(n);

  const astInterp = parse(tokenize(code));
  const interp = new Interpreter(astInterp, b, stdlib, inputOverrides);
  const outInterp = interp.run();

  const astCompiled = parse(tokenize(code));
  const interp2 = new Interpreter(astCompiled, b, stdlib, inputOverrides);
  const outCompiled = runCompiled(interp2);

  return { outInterp, outCompiled };
}

function expectIdentical(code: string, n: number, inputOverrides: Record<string, unknown> = {}) {
  const { outInterp, outCompiled } = compareInterpretedVsCompiled(code, n, inputOverrides);
  expect(JSON.stringify(outCompiled)).toBe(JSON.stringify(outInterp));
  return outCompiled;
}

describe("compiler - identifiers", () => {
  it("plain identifier reads match across every bar", () => {
    expectIdentical(
      `//@version=5
indicator("t")
x = close * 2
plot(x)
`,
      6
    );
  });

  it("OHLCV/bar_index built-ins match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(open + high + low + close + volume + bar_index)
`,
      5
    );
  });
});

describe("compiler - history references", () => {
  it("close[1]/high[3] history refs match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(close[1])
plot(high[3])
`,
      6
    );
  });

  it("history ref on a user-declared series matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
x = close
plot(x - x[2])
`,
      6
    );
  });
});

describe("compiler - assignment / reassignment / persistent variables", () => {
  it("plain (=) assignment matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
x = close * 2
plot(x)
`,
      5
    );
  });

  it("var (persistent) + := reassignment across bars matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
var acc = 0.0
acc := acc + close
plot(acc)
`,
      8
    );
  });

  it("varip matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
varip count = 0
count := count + 1
plot(count)
`,
      6
    );
  });
});

describe("compiler - binary / unary / conditional expressions", () => {
  it("arithmetic operators match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(close + open)
plot(close - open)
plot(close * 2)
plot(close / 2)
plot(close % 2)
`,
      5
    );
  });

  it("comparison and equality operators match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(close > open ? 1 : 0)
plot(close >= open ? 1 : 0)
plot(close == open ? 1 : 0)
plot(close != open ? 1 : 0)
`,
      5
    );
  });

  it("and/or short-circuit behavior matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
a = (close > open) and (high > low)
b = (close < open) or (high > low)
plot(a ? 1 : 0)
plot(b ? 1 : 0)
`,
      6
    );
  });

  it("unary not/minus match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(not (close > open) ? 1 : 0)
plot(-close)
`,
      5
    );
  });

  it("ternary and if/else expression match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
x = close > open ? 1 : 0
y = if close > open
    2
else
    3
plot(x)
plot(y)
`,
      6
    );
  });

  it("string concatenation and na-propagation match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
s = "x" + str.tostring(close)
plot(str.length(s))
`,
      4
    );
  });
});

describe("compiler - function calls", () => {
  it("stdlib global function calls match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(math.max(close, open))
plot(math.min(close, open))
plot(math.abs(close - open))
`,
      5
    );
  });

  it("stdlib namespace function calls match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
plot(ta.highest(high, 3))
plot(ta.lowest(low, 3))
`,
      6
    );
  });

  it("user-defined function calls match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
double(v) =>
    v * 2
plot(double(close))
`,
      5
    );
  });

  it("nested user-defined function calls match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
addOne(v) =>
    v + 1
a = addOne(close)
b = addOne(a)
plot(b)
`,
      5
    );
  });

  it("a function called with a nested call to ITSELF as an argument matches (arg-evaluation-order sensitive)", () => {
    expectIdentical(
      `//@version=5
indicator("t")
combine(a, b) =>
    a + b
x = combine(close, combine(close, open))
plot(x)
`,
      5
    );
  });

  it("input() default value and input() with an override both match", () => {
    expectIdentical(
      `//@version=5
indicator("t")
len = input.int(20, "Length")
plot(len)
`,
      5
    );
    expectIdentical(
      `//@version=5
indicator("t")
len = input.int(20, "Length")
plot(len)
`,
      5,
      { len: 55 }
    );
  });
});

describe("compiler - scopes", () => {
  it("a local variable inside a user function does not leak into the caller's scope, and vice versa", () => {
    expectIdentical(
      `//@version=5
indicator("t")
x = 100.0
addToX(v) =>
    x = 5.0
    v + x
plot(addToX(close))
plot(x)
`,
      5
    );
  });
});

describe("compiler - loops (fallback path, mixed with compiled surrounding code)", () => {
  it("a for-numeric loop still matches when surrounded by compiled statements", () => {
    expectIdentical(
      `//@version=5
indicator("t")
sum = 0.0
for i = 0 to 3
    sum := sum + i
plot(sum)
`,
      5
    );
  });
});

describe("compiler - drawing operations (line/box/label lifecycle)", () => {
  it("creating and NOT deleting a line/box/label matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
if bar_index == 0
    line.new(bar_index, close, bar_index + 1, close)
    box.new(bar_index, high, bar_index + 1, low)
    label.new(bar_index, close, "x")
`,
      3
    );
  });

  it("creating and deleting a line/box/label matches (both end up absent from output)", () => {
    expectIdentical(
      `//@version=5
indicator("t")
if bar_index == 0
    l = line.new(bar_index, close, bar_index + 1, close)
    line.delete(l)
    b = box.new(bar_index, high, bar_index + 1, low)
    box.delete(b)
    lbl = label.new(bar_index, close, "x")
    label.delete(lbl)
`,
      3
    );
  });

  it("a redraw-every-bar pattern (delete previous, draw new) matches every bar", () => {
    expectIdentical(
      `//@version=5
indicator("t")
var line l = na
if not na(l)
    line.delete(l)
l := line.new(bar_index, close, bar_index, close)
`,
      8
    );
  });
});

describe("compiler - strategy/trade output", () => {
  it("backtest.recordTrade output matches", () => {
    expectIdentical(
      `//@version=5
indicator("t")
if bar_index == 2
    strategy.entry("long", strategy.long)
if bar_index == 4
    strategy.close("long")
`,
      6
    );
  });
});

describe("compiler - series values over many bars (smoke check at larger n)", () => {
  it("a mix of every compiled feature stays byte-identical over 200 bars", () => {
    expectIdentical(
      `//@version=5
indicator("t")
var float highest = na
highest := na(highest) or high > highest ? high : highest
diff = close - close[5]
label.new(bar_index, close, str.tostring(diff))
plot(highest)
plot(diff)
`,
      200
    );
  });
});
