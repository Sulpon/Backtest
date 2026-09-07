"""
The real-time analogue of service.py's MarketDataService: owns the
lifecycle of live provider price streams (one dedicated thread per unique
subscribed symbol), fans out normalized ticks/candles/state to every
subscriber, and reconnects with exponential backoff on failure.

Deliberately in-memory / ephemeral only - live ticks and the in-progress
candles CandleAggregator builds from them are NEVER persisted to DuckDB.
A page refresh loses in-progress live bars (rebuilt from the next ticks
after resubscribing); historical REST/backfill data via
service.py/repository.py is completely unaffected. This is a deliberate
scope boundary (see the "Real-Time Forex Market Data" plan's "What is
explicitly NOT touched" section), not an oversight - it's what keeps this
module from ever needing runtime_db.py's write-path/locking machinery at
all.

Threading model, mirroring runtime_db.py's `_schema_lock` precedent: one
process-wide `threading.Lock` (`self._lock`) guards every shared dict below
(`_subscribers`, `_stop_events`, `_threads`, `_aggregators`, `_states`).
Exactly one lock, never a second one - the same reasoning runtime_db.py's
own docstring gives (two separate locks protecting state that's read/
written together would defeat the purpose). Per-symbol stream threads
dispatch to the owning asyncio event loop via `loop.call_soon_threadsafe`
because `asyncio.Queue.put_nowait` (used by the FastAPI WebSocket route to
receive messages) is not itself thread-safe - it must only ever be touched
from the loop's own thread.

Provider contract (a clarifying addition to `MarketDataProvider.
stream_prices`'s existing docstring, not a new abstract method): the
generator a provider yields from must yield at least every ~1s - a
heartbeat/duplicate quote is fine - so a per-symbol thread's shutdown
(`stop_event.is_set()`) is checked promptly rather than only whenever the
next real tick happens to arrive.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional

from .aggregator import LIVE_TIMEFRAMES, CandleAggregator
from .models import Candle
from .provider import MarketDataProvider
from .quotes import MarketQuote
from .symbols import SUPPORTED_SYMBOLS

logger = logging.getLogger(__name__)

_INITIAL_BACKOFF_SECONDS = 1.0
_MAX_BACKOFF_SECONDS = 30.0
# How often a MARKET_CLOSED symbol re-checks whether the market has opened -
# deliberately much coarser than the connection-failure backoff above, since
# "closed" is an expected, hours-long steady state, not a transient failure
# to retry aggressively.
_MARKET_CLOSED_POLL_SECONDS = 60.0


class StreamState(str, Enum):
    CONNECTING = "connecting"
    LIVE = "live"
    DISCONNECTED = "disconnected"
    RECONNECTING = "reconnecting"
    MARKET_CLOSED = "market_closed"


def is_forex_market_open(now_utc: datetime) -> bool:
    """Documented approximation, not a broker-verified session calendar:
    the global forex market is treated as closed from Friday 22:00 UTC
    through Sunday 22:00 UTC and open the rest of the week. Real brokers'
    exact open/close times vary by a small margin (and holidays aren't
    modeled at all) - this exists only to avoid needlessly hammering a
    provider's stream endpoint all weekend, not to gate anything
    trading-decision-relevant."""
    weekday = now_utc.weekday()  # Monday=0 ... Sunday=6
    if weekday == 5:  # Saturday - always closed
        return False
    if weekday == 4 and now_utc.hour >= 22:  # Friday from 22:00 UTC
        return False
    if weekday == 6 and now_utc.hour < 22:  # Sunday before 22:00 UTC
        return False
    return True


def _candle_message(candle: Candle, confirmed: bool) -> dict:
    return {
        "type": "candle",
        "confirmed": confirmed,
        "symbol": candle.instrument_id,
        "timeframe": candle.timeframe,
        "time": candle.timestamp_utc,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
    }


def _quote_message(symbol: str, quote: MarketQuote) -> dict:
    return {
        "type": "quote",
        "symbol": symbol,
        "bid": quote.bid,
        "ask": quote.ask,
        "mid": quote.mid,
        "spread": quote.spread,
        "timestamp_ms": quote.timestamp_ms,
        "source": quote.source,
    }


class MarketDataStreamService:
    """Refcounted subscribe/unsubscribe over one provider connection per
    unique subscribed symbol. `loop` and `wait_fn`/`now_fn` are injected
    (not read from a global) purely for testability - `wait_fn` in
    particular lets tests exercise backoff-state transitions without any
    real wall-clock wait (see test_stream_service.py)."""

    def __init__(
        self,
        provider: MarketDataProvider,
        loop,
        wait_fn: Optional[Callable[[threading.Event, float], bool]] = None,
        now_fn: Optional[Callable[[], datetime]] = None,
    ):
        self._provider = provider
        self._loop = loop
        # Default: threading.Event.wait()'s own return value is True exactly
        # when the event became set during the wait - the same "did we get
        # asked to stop while waiting" signal _run_symbol_stream needs.
        self._wait = wait_fn or (lambda stop_event, timeout: stop_event.wait(timeout))
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

        self._lock = threading.Lock()
        self._subscribers: dict[str, set] = {}
        self._stop_events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._aggregators: dict[str, CandleAggregator] = {}
        self._states: dict[str, StreamState] = {}

    def subscribe(self, symbol: str, queue) -> None:
        """`queue` is anything with a `put_nowait` method - in production an
        `asyncio.Queue` owned by one WebSocket connection; a plain
        `queue.Queue` (or a test double) works equally well for tests that
        never touch `call_soon_threadsafe`'s real event-loop plumbing."""
        if symbol not in SUPPORTED_SYMBOLS:
            raise ValueError(f"Unsupported symbol '{symbol}'")
        with self._lock:
            subs = self._subscribers.setdefault(symbol, set())
            is_new_symbol = len(subs) == 0
            subs.add(queue)
            if not is_new_symbol:
                return
            stop_event = threading.Event()
            self._stop_events[symbol] = stop_event
            self._aggregators[symbol] = CandleAggregator(symbol)
            self._states[symbol] = StreamState.CONNECTING
            thread = threading.Thread(
                target=self._run_symbol_stream,
                args=(symbol, stop_event),
                name=f"marketdata-stream-{symbol}",
                daemon=True,
            )
            self._threads[symbol] = thread
        thread.start()

    def unsubscribe(self, symbol: str, queue) -> None:
        stop_event: Optional[threading.Event] = None
        with self._lock:
            subs = self._subscribers.get(symbol)
            if subs is None or queue not in subs:
                return
            subs.discard(queue)
            if subs:
                return
            del self._subscribers[symbol]
            stop_event = self._stop_events.pop(symbol, None)
            self._aggregators.pop(symbol, None)
            self._states.pop(symbol, None)
            # `_threads[symbol]` is deliberately left for `_run_symbol_stream`
            # itself to pop once its loop actually exits (see below) - not
            # joined here, so unsubscribe (called from the WebSocket route's
            # disconnect handler) never blocks on a possibly-slow provider
            # network teardown.
        if stop_event is not None:
            stop_event.set()

    def get_state(self, symbol: str) -> Optional[StreamState]:
        with self._lock:
            return self._states.get(symbol)

    def shutdown(self) -> None:
        """Signals every running per-symbol thread to stop - called from
        the FastAPI lifespan's shutdown phase. Does not join threads (see
        unsubscribe's own reasoning above)."""
        with self._lock:
            stop_events = list(self._stop_events.values())
            self._subscribers.clear()
            self._stop_events.clear()
            self._aggregators.clear()
            self._states.clear()
        for stop_event in stop_events:
            stop_event.set()

    def _dispatch(self, symbol: str, stop_event: threading.Event, message: dict) -> None:
        with self._lock:
            # `stop_event` identity, not just symbol, is the actual
            # generation check: a rapid unsubscribe-then-resubscribe of the
            # SAME symbol (routine in dev - React StrictMode's mount ->
            # cleanup -> mount double-invoke does exactly this) starts a
            # brand-new thread/stop_event/aggregator for that symbol before
            # the OLD thread has necessarily noticed its own stop_event was
            # set (the provider-heartbeat contract only guarantees it
            # notices within ~1s). Without this check, the dying old
            # thread's one straggling tick would get dispatched into the
            # NEW subscription's queue and fed into the NEW aggregator,
            # right after a real resubscribe - a duplicate/out-of-order
            # artifact during the handoff window, not a rare corner case.
            if self._stop_events.get(symbol) is not stop_event:
                return
            queues = list(self._subscribers.get(symbol, ()))
        for q in queues:
            self._loop.call_soon_threadsafe(q.put_nowait, message)

    def _set_state(self, symbol: str, stop_event: threading.Event, state: StreamState) -> None:
        with self._lock:
            if self._stop_events.get(symbol) is not stop_event:
                return  # this thread's generation was superseded or unsubscribed - never resurrect/clobber a newer one
            self._states[symbol] = state
        self._dispatch(symbol, stop_event, {"type": "status", "symbol": symbol, "state": state.value})

    def _process_quote(self, symbol: str, stop_event: threading.Event, quote: MarketQuote) -> None:
        self._dispatch(symbol, stop_event, _quote_message(symbol, quote))

        with self._lock:
            if self._stop_events.get(symbol) is not stop_event:
                return  # superseded/unsubscribed concurrently - drop this tick, nothing current left to aggregate for
            aggregator = self._aggregators.get(symbol)
        if aggregator is None:
            return

        confirmed = aggregator.on_quote(quote)
        for candle in confirmed:
            self._dispatch(symbol, stop_event, _candle_message(candle, confirmed=True))
        for tf in LIVE_TIMEFRAMES:
            current = aggregator.current_candle(tf)
            if current is not None:
                self._dispatch(symbol, stop_event, _candle_message(current, confirmed=False))

    def _run_symbol_stream(self, symbol: str, stop_event: threading.Event) -> None:
        backoff = _INITIAL_BACKOFF_SECONDS
        try:
            while not stop_event.is_set():
                if not is_forex_market_open(self._now()):
                    self._set_state(symbol, stop_event, StreamState.MARKET_CLOSED)
                    if self._wait(stop_event, _MARKET_CLOSED_POLL_SECONDS):
                        break
                    continue

                self._set_state(symbol, stop_event, StreamState.CONNECTING)
                try:
                    for quote in self._provider.stream_prices([symbol]):
                        if stop_event.is_set():
                            break
                        backoff = _INITIAL_BACKOFF_SECONDS
                        self._set_state(symbol, stop_event, StreamState.LIVE)
                        self._process_quote(symbol, stop_event, quote)
                except Exception as exc:  # provider/network failure - reconnect with backoff, never crash the thread
                    logger.warning("marketdata stream for %s failed: %s", symbol, exc)
                    self._dispatch(symbol, stop_event, {"type": "error", "symbol": symbol, "message": str(exc)})

                if stop_event.is_set():
                    break
                self._set_state(symbol, stop_event, StreamState.RECONNECTING)
                if self._wait(stop_event, backoff):
                    break
                backoff = min(backoff * 2, _MAX_BACKOFF_SECONDS)
        finally:
            # Generation-checked (see _set_state) - a superseded (resubscribed)
            # generation's own late DISCONNECTED report is correctly dropped
            # here rather than clobbering the new generation's more current
            # state, with no special-casing needed beyond the same check
            # every other call site already uses.
            self._set_state(symbol, stop_event, StreamState.DISCONNECTED)
            with self._lock:
                self._threads.pop(symbol, None)
