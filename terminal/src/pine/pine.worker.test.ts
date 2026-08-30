import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import { Interpreter, type Bar } from "./interpreter";
import { buildStdlib } from "./stdlib";
import { handleWorkerRequest } from "./pine.worker";

/**
 * Regression tests for pine.worker.ts's handleWorkerRequest - the pure
 * request -> response logic extracted from onmessage so it's directly
 * unit-testable without a real Worker/jsdom shim. Confirms:
 *  - handleWorkerRequest returns a hand-verified output shape (plot
 *    points, requestId passthrough, empty errors) for a small fixed
 *    script routed through the getOrParseAst source->AST cache - this is
 *    checked against literal expected values rather than by re-running
 *    interp.run() separately, since handleWorkerRequest itself calls
 *    interp.run() internally (comparing its output to a second, separate
 *    interp.run() call would be tautological now that there's only one
 *    execution path; see pine.worker.ts's module doc comment for why
 *    compiler.ts's runCompiled() is not wired in here).
 *  - the AST cache (keyed on raw source string) does not leak bar-specific
 *    state across requests that share the same code but different bars.
 *  - ParseError and PineRuntimeError are both still surfaced the same way,
 *    exactly as before this file's onmessage body was refactored into
 *    handleWorkerRequest.
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

describe("handleWorkerRequest - output shape for a small fixed script", () => {
  it("returns hand-verified plot points, requestId passthrough, and empty errors", () => {
    const code = `//@version=5
indicator("t")
plot(bar_index)
`;
    // bars(3) times: 1000, 4600, 8200 (1000 + i*3600); bar_index: 0, 1, 2 -
    // both exact integers, so the expected points below are hand-verified
    // literal values, not float-arithmetic-sensitive.
    const response = handleWorkerRequest({ requestId: 99, code, bars: bars(3), inputOverrides: {} });

    expect(response.requestId).toBe(99);
    expect(response.fatalError).toBeNull();
    expect(response.outputs.errors).toEqual([]);
    expect(response.outputs.plots).toHaveLength(1);
    expect(response.outputs.plots[0].points).toEqual([
      { time: 1000, value: 0 },
      { time: 4600, value: 1 },
      { time: 8200, value: 2 },
    ]);
  });
});

describe("handleWorkerRequest - AST cache does not leak bar-specific state", () => {
  const code = `//@version=5
indicator("t")
plot(close)
`;

  it("same code, different bars arrays each produce their own correct independent output", () => {
    const barsA = bars(5);
    const barsB = bars(5).map((bar, i) => ({ ...bar, close: bar.close + 100 + i }));

    const respA = handleWorkerRequest({ requestId: 1, code, bars: barsA, inputOverrides: {} });
    const respB = handleWorkerRequest({ requestId: 2, code, bars: barsB, inputOverrides: {} });

    expect(respA.fatalError).toBeNull();
    expect(respB.fatalError).toBeNull();
    expect(JSON.stringify(respA.outputs.plots)).not.toBe(JSON.stringify(respB.outputs.plots));

    // Confirm each response's plotted values actually match its own bars,
    // not the other request's (i.e. no cross-contamination via astCache).
    const stdlib = buildStdlib();
    const astA = parse(tokenize(code));
    const expectedA = new Interpreter(astA, barsA, stdlib, {}).run();
    const astB = parse(tokenize(code));
    const expectedB = new Interpreter(astB, barsB, stdlib, {}).run();
    expect(JSON.stringify(respA.outputs)).toBe(JSON.stringify(expectedA));
    expect(JSON.stringify(respB.outputs)).toBe(JSON.stringify(expectedB));
  });
});

describe("handleWorkerRequest - error surfacing", () => {
  it("surfaces a ParseError as fatalError", () => {
    const code = `//@version=5
indicator("t")
plot(
`;
    const response = handleWorkerRequest({ requestId: 3, code, bars: bars(3), inputOverrides: {} });

    expect(response.fatalError).not.toBeNull();
    expect(response.outputs.errors).toHaveLength(1);
    expect(response.outputs.errors[0]).toBe(response.fatalError);
    expect(response.outputs.plots).toEqual([]);
    expect(response.inputDefs).toEqual([]);
  });

  it("surfaces a PineRuntimeError (mid-script, e.g. an unknown function call) in outputs.errors, matching interp.run()'s existing per-bar catch/continue behavior", () => {
    // A PineRuntimeError thrown while executing a bar is caught INSIDE
    // run()'s own per-bar try/catch (see interpreter.ts's run()) - it's
    // pushed onto interp.errors and aborts the remaining bars, but does
    // not propagate out to handleWorkerRequest's try/catch. So fatalError
    // stays null; this is pre-existing behavior, not something this
    // refactor changed.
    const code = `//@version=5
indicator("t")
plot(thisFunctionDoesNotExist(close))
`;
    const b = bars(3);
    const stdlib = buildStdlib();
    const ast = parse(tokenize(code));
    const expected = new Interpreter(ast, b, stdlib, {}).run();

    const response = handleWorkerRequest({ requestId: 4, code, bars: b, inputOverrides: {} });

    expect(response.fatalError).toBeNull();
    expect(response.outputs.errors).toHaveLength(1);
    expect(response.outputs.errors[0]).toContain("thisFunctionDoesNotExist");
    expect(JSON.stringify(response.outputs)).toBe(JSON.stringify(expected));
  });
});
