import { API_BASE } from "./DataLayer";

/**
 * A standalone singleton - deliberately NOT folded into DataLayer.ts.
 * DataLayer is a stateless request/response abstraction with interchangeable
 * implementations; a live socket has fundamentally different lifecycle/
 * reconnect state, the same reasoning chartRegistry.ts/replayStore.ts
 * already have for living as their own standalone modules rather than
 * being methods on some other store.
 */

export interface MarketDataQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestampMs: number;
  source: string;
}

export interface MarketDataCandle {
  symbol: string;
  timeframe: string;
  confirmed: boolean;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Reflects THIS BROWSER TAB'S OWN WebSocket connection lifecycle only -
 * "connecting"/"open"/"reconnecting"/"closed" - not any one symbol's
 * backend-side provider stream state (that's MarketDataSymbolStatus, right
 * below - surfaced separately since "my browser's socket is open" and "this
 * symbol's provider stream is actually live" are genuinely different
 * things: the socket can be open while every subscribed symbol is still
 * mid-reconnect, or the whole market is simply closed for the weekend).
 * "closed" specifically means "no subscribers, so no socket is open right
 * now" - a normal idle state, not a failure. */
export type MarketDataConnectionState = "connecting" | "open" | "reconnecting" | "closed";

/** One subscribed symbol's REAL backend-side provider stream state, exactly
 * mirroring stream_service.py's `StreamState` enum values - this is what the
 * user's "MARKET STATUS" requirement actually means by LIVE/CONNECTING/
 * DISCONNECTED/RECONNECTING/MARKET_CLOSED: "LIVE means actual market updates
 * are being received," never just "a connection exists." Sourced from the
 * backend's `{"type":"status","symbol":...,"state":...}` messages - never
 * inferred client-side from `MarketDataConnectionState` alone, since a
 * healthy browser socket says nothing about whether THIS symbol's upstream
 * provider connection is actually live. */
export type MarketDataSymbolStatus = "connecting" | "live" | "disconnected" | "reconnecting" | "market_closed";

type QuoteListener = (quote: MarketDataQuote) => void;
type CandleListener = (candle: MarketDataCandle) => void;
type StateListener = (state: MarketDataConnectionState) => void;
type SymbolStatusListener = (symbol: string, status: MarketDataSymbolStatus) => void;
type Unsubscribe = () => void;

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function wsUrlFromApiBase(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/market-data";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** One browser WebSocket, refcounted per-symbol subscriptions (so two chart
 * panes on the same symbol share one backend subscription, mirroring
 * MarketDataStreamService's own per-symbol refcounting), and independent
 * exponential-backoff reconnect (1s -> 30s cap) - the frontend analogue of
 * stream_service.py's own backoff. */
export class MarketDataSocket {
  private ws: WebSocket | null = null;
  private refcounts = new Map<string, number>();
  private quoteListeners = new Set<QuoteListener>();
  private candleListeners = new Set<CandleListener>();
  private stateListeners = new Set<StateListener>();
  private symbolStatusListeners = new Set<SymbolStatusListener>();
  private symbolStatuses = new Map<string, MarketDataSymbolStatus>();
  private state: MarketDataConnectionState = "closed";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wsUrl: string;
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(apiBase: string = API_BASE, WebSocketCtor: typeof WebSocket = WebSocket) {
    this.wsUrl = wsUrlFromApiBase(apiBase);
    this.WebSocketCtor = WebSocketCtor;
  }

  getState(): MarketDataConnectionState {
    return this.state;
  }

  subscribeSymbol(symbol: string): void {
    const count = (this.refcounts.get(symbol) ?? 0) + 1;
    this.refcounts.set(symbol, count);
    this.ensureConnected();
    if (count === 1) {
      this.send({ action: "subscribe", symbol });
    }
  }

  unsubscribeSymbol(symbol: string): void {
    const current = this.refcounts.get(symbol);
    if (current === undefined) return;
    if (current <= 1) {
      this.refcounts.delete(symbol);
      this.symbolStatuses.delete(symbol); // a fresh future resubscribe starts clean, not showing a stale status from before
      this.send({ action: "unsubscribe", symbol });
      if (this.refcounts.size === 0) {
        this.disconnect();
      }
    } else {
      this.refcounts.set(symbol, current - 1);
    }
  }

  onQuote(listener: QuoteListener): Unsubscribe {
    this.quoteListeners.add(listener);
    return () => this.quoteListeners.delete(listener);
  }

  onCandle(listener: CandleListener): Unsubscribe {
    this.candleListeners.add(listener);
    return () => this.candleListeners.delete(listener);
  }

  onState(listener: StateListener): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The last known status for `symbol`, or undefined if no status message
   * has arrived for it yet (e.g. just subscribed, still waiting on the
   * backend's first CONNECTING report). */
  getSymbolStatus(symbol: string): MarketDataSymbolStatus | undefined {
    return this.symbolStatuses.get(symbol);
  }

  onSymbolStatus(listener: SymbolStatusListener): Unsubscribe {
    this.symbolStatusListeners.add(listener);
    return () => this.symbolStatusListeners.delete(listener);
  }

  private ensureConnected(): void {
    if (this.ws && (this.ws.readyState === this.WebSocketCtor.OPEN || this.ws.readyState === this.WebSocketCtor.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer !== null) return; // a reconnect is already scheduled - let it run
    this.connect();
  }

  private disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
    this.setState("closed");
  }

  private connect(): void {
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new this.WebSocketCtor(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // a stale handler from an already-superseded socket
      this.reconnectAttempt = 0;
      this.setState("open");
      for (const symbol of this.refcounts.keys()) {
        this.send({ action: "subscribe", symbol });
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.refcounts.size === 0) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };

    // onerror carries no useful detail in the browser WebSocket API - the
    // browser always follows it with onclose, which is where reconnect
    // scheduling actually happens.
    ws.onerror = () => undefined;

    ws.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === this.WebSocketCtor.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
    // Not open yet - onopen's own resend-every-subscribed-symbol loop above
    // covers this once the connection actually completes; no queueing
    // needed here.
  }

  private setState(state: MarketDataConnectionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // malformed frame - drop it, never throw out of a WebSocket event handler
    }

    if (message.type === "quote") {
      const quote: MarketDataQuote = {
        symbol: String(message.symbol),
        bid: Number(message.bid),
        ask: Number(message.ask),
        mid: Number(message.mid),
        spread: Number(message.spread),
        timestampMs: Number(message.timestamp_ms),
        source: String(message.source),
      };
      for (const listener of this.quoteListeners) listener(quote);
    } else if (message.type === "candle") {
      const candle: MarketDataCandle = {
        symbol: String(message.symbol),
        timeframe: String(message.timeframe),
        confirmed: Boolean(message.confirmed),
        time: Number(message.time),
        open: Number(message.open),
        high: Number(message.high),
        low: Number(message.low),
        close: Number(message.close),
      };
      for (const listener of this.candleListeners) listener(candle);
    } else if (message.type === "status") {
      const symbol = String(message.symbol);
      const status = String(message.state) as MarketDataSymbolStatus;
      this.symbolStatuses.set(symbol, status);
      for (const listener of this.symbolStatusListeners) listener(symbol, status);
    }
    // "error" messages: no dedicated listener type this pass - a symbol-
    // level stream error is already implied by its status transitioning to
    // "reconnecting"/"disconnected", which onSymbolStatus already surfaces.
  }
}

export const marketDataSocket = new MarketDataSocket();
