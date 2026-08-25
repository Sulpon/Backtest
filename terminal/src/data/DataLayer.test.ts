import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiDataLayer } from "./DataLayer";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("ApiDataLayer request deduplication", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listSymbols: two concurrent calls (React StrictMode's double-invoked effect) share one network request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ symbol: "EURUSD" }, { symbol: "GBPUSD" }]));
    const layer = new ApiDataLayer("http://api.test");

    const [a, b] = await Promise.all([layer.listSymbols(), layer.listSymbols()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(["EURUSD", "GBPUSD"]);
    expect(b).toEqual(a);
  });

  it("listSymbols: a later call after the first resolves reuses the same cached promise, not a new request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ symbol: "EURUSD" }]));
    const layer = new ApiDataLayer("http://api.test");

    await layer.listSymbols();
    await layer.listSymbols();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getQuotes: two concurrent calls for the same timeframe share one network request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ symbol: "EURUSD", last: 1.1, prev: 1.09 }]));
    const layer = new ApiDataLayer("http://api.test");

    const [a, b] = await Promise.all([layer.getQuotes("1h"), layer.getQuotes("1h")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("getQuotes: different timeframes are NOT deduplicated against each other", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([{ symbol: "EURUSD", last: 1.1, prev: 1.09 }]));
    const layer = new ApiDataLayer("http://api.test");

    await Promise.all([layer.getQuotes("1h"), layer.getQuotes("4h")]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("getSymbolData: two concurrent calls for the same symbol+timeframe share one network request", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        symbol: "EURUSD",
        timeframe: "1h",
        bars: [],
        swingPoints: [],
        bosEvents: [],
        fvgEvents: [],
        orderBlocks: [],
        volumeImbalanceEvents: [],
        liquidityEvents: [],
        trades: [],
        stats: null,
      })
    );
    const layer = new ApiDataLayer("http://api.test");

    await Promise.all([layer.getSymbolData("EURUSD", "1h"), layer.getSymbolData("EURUSD", "1h")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hasCachedSymbolData: false before any fetch, true once one has been issued (even before it resolves)", async () => {
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    const layer = new ApiDataLayer("http://api.test");

    expect(layer.hasCachedSymbolData("EURUSD", "1h")).toBe(false);
    const pending = layer.getSymbolData("EURUSD", "1h");
    expect(layer.hasCachedSymbolData("EURUSD", "1h")).toBe(true);
    expect(layer.hasCachedSymbolData("GBPUSD", "1h")).toBe(false);

    resolveFetch(
      jsonResponse({
        symbol: "EURUSD",
        timeframe: "1h",
        bars: [],
        swingPoints: [],
        bosEvents: [],
        fvgEvents: [],
        orderBlocks: [],
        volumeImbalanceEvents: [],
        liquidityEvents: [],
        trades: [],
        stats: null,
      })
    );
    await pending;
    expect(layer.hasCachedSymbolData("EURUSD", "1h")).toBe(true);
  });

  it("getSymbolDataWindowed passes the limit param and is never cached (always issues a fresh request)", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        symbol: "EURUSD",
        timeframe: "1h",
        bars: [],
        swingPoints: [],
        bosEvents: [],
        fvgEvents: [],
        orderBlocks: [],
        volumeImbalanceEvents: [],
        liquidityEvents: [],
        trades: [],
        stats: null,
      })
    );
    const layer = new ApiDataLayer("http://api.test");

    await layer.getSymbolDataWindowed("EURUSD", "1h", 3000);
    await layer.getSymbolDataWindowed("EURUSD", "1h", 3000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("limit=3000");
  });
});
