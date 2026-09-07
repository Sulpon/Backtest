import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketDataSocket } from "./MarketDataSocket";

/** Minimal fake for the global `WebSocket` - the tests drive
 * open/close/message events explicitly via the trigger* methods rather
 * than needing a real browser/server, matching this project's existing
 * "mock the global fetch/WebSocket" testing convention (see
 * DataLayer.test.ts's `vi.stubGlobal("fetch", ...)`). */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  closeCalled = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error("no FakeWebSocket was constructed");
  return socket;
}

function newFakeSocketClass(): typeof WebSocket {
  FakeWebSocket.instances = [];
  return FakeWebSocket as unknown as typeof WebSocket;
}

describe("MarketDataSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribeSymbol opens a socket and sends subscribe once connected", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());

    socket.subscribeSymbol("EURUSD");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latestSocket().sent).toHaveLength(0); // not open yet - nothing sent before onopen

    latestSocket().triggerOpen();
    expect(latestSocket().sent).toEqual([JSON.stringify({ action: "subscribe", symbol: "EURUSD" })]);
  });

  it("derives ws:// from an http:// API base and preserves /ws/market-data", () => {
    const socket = new MarketDataSocket("http://api.test:8000", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    expect(latestSocket().url).toBe("ws://api.test:8000/ws/market-data");
  });

  it("derives wss:// from an https:// API base", () => {
    const socket = new MarketDataSocket("https://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    expect(latestSocket().url).toBe("wss://api.test/ws/market-data");
  });

  it("regression: an empty apiBase (Vercel production's real same-origin config, e.g. VITE_API_BASE=\"\") resolves against the page's own origin instead of throwing - this crashed the entire app on production before the fix, since the module-level marketDataSocket singleton constructs this URL eagerly at import time, before React ever mounts", () => {
    expect(() => new MarketDataSocket("", newFakeSocketClass())).not.toThrow();
    const socket = new MarketDataSocket("", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    const url = latestSocket().url;
    expect(url.startsWith("ws://") || url.startsWith("wss://")).toBe(true);
    expect(url.endsWith("/ws/market-data")).toBe(true);
  });

  it("a second subscribe for the same symbol does not resend subscribe (refcount dedup)", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    socket.subscribeSymbol("EURUSD");

    const subscribeMessages = latestSocket().sent.filter((s) => JSON.parse(s).action === "subscribe");
    expect(subscribeMessages).toHaveLength(1);
  });

  it("a second subscribe for a DIFFERENT symbol does send its own subscribe", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    socket.subscribeSymbol("GBPUSD");

    expect(latestSocket().sent).toEqual([
      JSON.stringify({ action: "subscribe", symbol: "EURUSD" }),
      JSON.stringify({ action: "subscribe", symbol: "GBPUSD" }),
    ]);
  });

  it("unsubscribing while another subscriber remains does not send unsubscribe", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    socket.subscribeSymbol("EURUSD"); // second subscriber, same symbol

    socket.unsubscribeSymbol("EURUSD");
    const unsubscribeMessages = latestSocket().sent.filter((s) => JSON.parse(s).action === "unsubscribe");
    expect(unsubscribeMessages).toHaveLength(0);
  });

  it("unsubscribing the last subscriber sends unsubscribe and closes the socket", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();

    socket.unsubscribeSymbol("EURUSD");

    expect(latestSocket().sent.at(-1)).toBe(JSON.stringify({ action: "unsubscribe", symbol: "EURUSD" }));
    expect(latestSocket().closeCalled).toBe(true);
  });

  it("reconnects with exponential backoff (1s, 2s, 4s, ...) capped at 30s while a subscriber remains", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const states: string[] = [];
    socket.onState((s) => states.push(s));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    expect(FakeWebSocket.instances).toHaveLength(1);

    latestSocket().triggerClose(); // connection drops - subscriber still wants EURUSD
    expect(states.at(-1)).toBe("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1); // no new socket yet - waiting out the 1s backoff

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnected after 1s

    latestSocket().triggerClose(); // fails again immediately - backoff should now be 2s
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("backoff resets to 1s after a successful reconnect", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    latestSocket().triggerClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    latestSocket().triggerOpen(); // reconnect succeeded - backoff must reset
    latestSocket().triggerClose(); // fails again right away

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3); // 1s again, not 2s
  });

  it("does not reconnect at all once there are no remaining subscribers", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const states: string[] = [];
    socket.onState((s) => states.push(s));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    socket.unsubscribeSymbol("EURUSD"); // explicit unsubscribe closes and resets - no pending reconnect

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(states.at(-1)).toBe("closed");
  });

  it("parses an incoming quote message and notifies onQuote listeners", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const quotes: unknown[] = [];
    socket.onQuote((q) => quotes.push(q));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    latestSocket().triggerMessage({
      type: "quote",
      symbol: "EURUSD",
      bid: 1.1,
      ask: 1.1002,
      mid: 1.1001,
      spread: 0.0002,
      timestamp_ms: 1_700_000_000_000,
      source: "mock_stream",
    });

    expect(quotes).toEqual([
      {
        symbol: "EURUSD",
        bid: 1.1,
        ask: 1.1002,
        mid: 1.1001,
        spread: 0.0002,
        timestampMs: 1_700_000_000_000,
        source: "mock_stream",
      },
    ]);
  });

  it("parses an incoming candle message and notifies onCandle listeners", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const candles: unknown[] = [];
    socket.onCandle((c) => candles.push(c));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    latestSocket().triggerMessage({
      type: "candle",
      confirmed: false,
      symbol: "EURUSD",
      timeframe: "1m",
      time: 0,
      open: 1.1,
      high: 1.11,
      low: 1.09,
      close: 1.105,
    });

    expect(candles).toEqual([
      { symbol: "EURUSD", timeframe: "1m", confirmed: false, time: 0, open: 1.1, high: 1.11, low: 1.09, close: 1.105 },
    ]);
  });

  it("ignores a malformed (non-JSON) message instead of throwing", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();

    expect(() => latestSocket().onmessage?.({ data: "not json" })).not.toThrow();
  });

  it("parses an incoming status message, notifies onSymbolStatus, and exposes it via getSymbolStatus", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const seen: Array<[string, string]> = [];
    socket.onSymbolStatus((symbol, status) => seen.push([symbol, status]));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    expect(socket.getSymbolStatus("EURUSD")).toBeUndefined(); // no status message yet - must never default to "live"

    latestSocket().triggerMessage({ type: "status", symbol: "EURUSD", state: "live" });

    expect(seen).toEqual([["EURUSD", "live"]]);
    expect(socket.getSymbolStatus("EURUSD")).toBe("live");
  });

  it("a symbol's status is cleared on unsubscribe so a later resubscribe never shows a stale status", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    latestSocket().triggerMessage({ type: "status", symbol: "EURUSD", state: "live" });
    expect(socket.getSymbolStatus("EURUSD")).toBe("live");

    socket.unsubscribeSymbol("EURUSD");

    expect(socket.getSymbolStatus("EURUSD")).toBeUndefined();
  });

  it("a status message for one symbol does not affect another symbol's status", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    socket.subscribeSymbol("EURUSD");
    socket.subscribeSymbol("GBPUSD");
    latestSocket().triggerOpen();

    latestSocket().triggerMessage({ type: "status", symbol: "EURUSD", state: "live" });
    latestSocket().triggerMessage({ type: "status", symbol: "GBPUSD", state: "market_closed" });

    expect(socket.getSymbolStatus("EURUSD")).toBe("live");
    expect(socket.getSymbolStatus("GBPUSD")).toBe("market_closed");
  });

  it("an onQuote/onCandle/onState unsubscribe function stops further notifications", () => {
    const socket = new MarketDataSocket("http://api.test", newFakeSocketClass());
    const quotes: unknown[] = [];
    const unsubscribeListener = socket.onQuote((q) => quotes.push(q));

    socket.subscribeSymbol("EURUSD");
    latestSocket().triggerOpen();
    unsubscribeListener();
    latestSocket().triggerMessage({
      type: "quote",
      symbol: "EURUSD",
      bid: 1.1,
      ask: 1.11,
      mid: 1.105,
      spread: 0.01,
      timestamp_ms: 0,
      source: "mock_stream",
    });

    expect(quotes).toHaveLength(0);
  });
});
