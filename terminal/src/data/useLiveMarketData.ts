import { useEffect, useState } from "react";
import {
  marketDataSocket,
  type MarketDataCandle,
  type MarketDataConnectionState,
  type MarketDataQuote,
  type MarketDataSymbolStatus,
} from "./MarketDataSocket";

/** React hook layer over MarketDataSocket - kept in its own module so the
 * socket class itself stays framework-agnostic and unit-testable without
 * React Testing Library (see MarketDataSocket.test.ts). */

/** Live bid/ask/mid/spread for `symbol`, or `undefined` before the first
 * tick arrives (or when `symbol` is null - e.g. no pane focused yet).
 * Subscribes/unsubscribes exactly once per `symbol` change; refcounting
 * against every other subscriber of the same symbol happens inside
 * MarketDataSocket itself. */
export function useMarketQuote(symbol: string | null): MarketDataQuote | undefined {
  const [quote, setQuote] = useState<MarketDataQuote | undefined>(undefined);

  useEffect(() => {
    if (!symbol) return;
    setQuote(undefined);
    marketDataSocket.subscribeSymbol(symbol);
    const unsubscribeListener = marketDataSocket.onQuote((q) => {
      if (q.symbol === symbol) setQuote(q);
    });
    return () => {
      unsubscribeListener();
      marketDataSocket.unsubscribeSymbol(symbol);
    };
  }, [symbol]);

  return quote;
}

/** The in-progress (confirmed: false) or just-confirmed (confirmed: true)
 * live bar for `symbol`/`timeframe`, or `undefined` before the first
 * matching candle message arrives. One tick stream already produces every
 * LIVE_TIMEFRAMES granularity server-side - this hook is what does the
 * client-side timeframe filtering the plan describes. */
export function useLiveCandle(symbol: string | null, timeframe: string | null): MarketDataCandle | undefined {
  const [candle, setCandle] = useState<MarketDataCandle | undefined>(undefined);

  useEffect(() => {
    if (!symbol || !timeframe) return;
    setCandle(undefined);
    marketDataSocket.subscribeSymbol(symbol);
    const unsubscribeListener = marketDataSocket.onCandle((c) => {
      if (c.symbol === symbol && c.timeframe === timeframe) setCandle(c);
    });
    return () => {
      unsubscribeListener();
      marketDataSocket.unsubscribeSymbol(symbol);
    };
  }, [symbol, timeframe]);

  return candle;
}

/** This browser tab's own live-market-data WebSocket connection state -
 * see MarketDataConnectionState's doc comment for what it does/doesn't
 * represent. Takes no arguments: it's one shared socket for the whole
 * page, not one per symbol. */
export function useMarketDataStreamState(): MarketDataConnectionState {
  const [state, setState] = useState<MarketDataConnectionState>(marketDataSocket.getState());

  useEffect(() => marketDataSocket.onState(setState), []);

  return state;
}

/** `symbol`'s REAL backend-side provider stream status (LIVE/CONNECTING/
 * DISCONNECTED/RECONNECTING/MARKET_CLOSED) - this, not
 * useMarketDataStreamState, is what a per-symbol UI status indicator (e.g.
 * a chart pane's header, or a watchlist row) should show, per the user's
 * explicit "do not show LIVE simply because the connection exists"
 * requirement. `undefined` before the first status message for this symbol
 * arrives (e.g. immediately after subscribing) - render that as a neutral/
 * unknown state, never as LIVE. Does NOT itself call subscribeSymbol/
 * unsubscribeSymbol - pair this with useMarketQuote/useLiveCandle (or an
 * explicit subscribe of your own) for the symbol you're already displaying,
 * so this hook never keeps a stream alive on its own that nothing is
 * actually showing. */
export function useSymbolMarketStatus(symbol: string | null): MarketDataSymbolStatus | undefined {
  const [status, setStatus] = useState<MarketDataSymbolStatus | undefined>(symbol ? marketDataSocket.getSymbolStatus(symbol) : undefined);

  useEffect(() => {
    if (!symbol) {
      setStatus(undefined);
      return;
    }
    setStatus(marketDataSocket.getSymbolStatus(symbol));
    return marketDataSocket.onSymbolStatus((sym, s) => {
      if (sym === symbol) setStatus(s);
    });
  }, [symbol]);

  return status;
}
