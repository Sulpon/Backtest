"""
MarketDataStreamService - refcounting, one-thread-per-symbol, and backoff/
market-closed state transitions. Uses a fake provider (a plain Python
generator function under test control) and a monkeypatched `wait_fn` so
nothing here ever performs a real wall-clock sleep - `wait_fn` is invoked
synchronously and returns immediately, with the test driving how many
"iterations" a background thread performs via a counting stop condition.
"""
import queue
import threading
import time
from datetime import datetime, timezone

import pytest

from app.marketdata.provider import MarketDataProvider, ProviderInstrument
from app.marketdata.quotes import MarketQuote
from app.marketdata.stream_service import MarketDataStreamService, StreamState, is_forex_market_open


class FakeLoop:
    """Stand-in for the real asyncio event loop - `call_soon_threadsafe`
    just calls the function immediately, since these tests are entirely
    single-process/synchronous-enough that there's no real cross-thread
    asyncio queue involved (a plain `queue.Queue`, not `asyncio.Queue`, is
    used as the subscriber "queue" below)."""

    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


class OneShotProvider(MarketDataProvider):
    """Yields exactly the quotes it's given, then blocks (via a
    `threading.Event`) until the test lets it stop - simulating a
    provider connection that stays open."""

    name = "fake"

    def __init__(self, quotes, hang_event):
        self._quotes = quotes
        self._hang_event = hang_event

    def list_instruments(self):
        return [ProviderInstrument("EUR_USD", "EURUSD", 5, -4, None, None)]

    def get_candles(self, symbol, timeframe, start, end):
        return []

    def stream_prices(self, symbols):
        for q in self._quotes:
            yield q
        self._hang_event.wait(timeout=5.0)  # simulates "still connected, no new ticks" until the test stops it


class FailingProvider(MarketDataProvider):
    name = "failing"

    def list_instruments(self):
        return []

    def get_candles(self, symbol, timeframe, start, end):
        return []

    def stream_prices(self, symbols):
        raise ConnectionError("boom")
        yield  # pragma: no cover - makes this a generator function


def _wait_for(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


# A fixed weekday/open-market timestamp for every test below EXCEPT the
# dedicated market-closed test - `is_forex_market_open`'s own real-clock
# default would otherwise make every other test's outcome depend on
# whatever day/time the suite happens to run (see
# test_market_closed_state_when_now_fn_reports_weekend for the one test
# that deliberately exercises the closed branch).
_OPEN_MARKET_NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)  # a Tuesday


def _open_market_now_fn():
    return _OPEN_MARKET_NOW


def test_subscribe_starts_exactly_one_thread_per_symbol():
    hang = threading.Event()
    provider = OneShotProvider([MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=1.11, source="fake")], hang)
    service = MarketDataStreamService(provider, FakeLoop(), now_fn=_open_market_now_fn)
    q1, q2 = queue.Queue(), queue.Queue()

    service.subscribe("EURUSD", q1)
    service.subscribe("EURUSD", q2)  # second subscriber, same symbol - must NOT start a second thread

    assert len(service._threads) == 1
    hang.set()
    service.shutdown()


def test_unsubscribe_last_subscriber_stops_the_thread():
    hang = threading.Event()
    provider = OneShotProvider([MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=1.11, source="fake")], hang)
    service = MarketDataStreamService(provider, FakeLoop(), now_fn=_open_market_now_fn)
    q1 = queue.Queue()
    service.subscribe("EURUSD", q1)

    assert _wait_for(lambda: service.get_state("EURUSD") == StreamState.LIVE)
    service.unsubscribe("EURUSD", q1)
    hang.set()  # let the blocked generator return so the thread can actually exit

    assert _wait_for(lambda: "EURUSD" not in service._threads)
    assert service.get_state("EURUSD") is None


def test_quotes_are_dispatched_only_to_subscribers_of_that_symbol():
    hang = threading.Event()
    quote = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=1.11, source="fake")
    provider = OneShotProvider([quote], hang)
    service = MarketDataStreamService(provider, FakeLoop(), now_fn=_open_market_now_fn)

    q_eur: "queue.Queue" = queue.Queue()
    service.subscribe("EURUSD", q_eur)

    assert _wait_for(lambda: not q_eur.empty())
    messages = []
    while not q_eur.empty():
        messages.append(q_eur.get_nowait())

    quote_messages = [m for m in messages if m["type"] == "quote"]
    assert len(quote_messages) == 1
    assert quote_messages[0]["symbol"] == "EURUSD"
    assert quote_messages[0]["bid"] == 1.10
    assert quote_messages[0]["ask"] == 1.11
    assert quote_messages[0]["mid"] == pytest.approx(1.105)

    candle_messages = [m for m in messages if m["type"] == "candle"]
    assert len(candle_messages) == 7  # one forming candle per LIVE_TIMEFRAMES entry

    hang.set()
    service.shutdown()


def test_provider_failure_triggers_reconnecting_state_and_backoff_wait():
    service = MarketDataStreamService(FailingProvider(), FakeLoop(), now_fn=_open_market_now_fn)
    wait_calls = []

    def fake_wait(stop_event, timeout):
        wait_calls.append(timeout)
        if len(wait_calls) >= 3:
            stop_event.set()  # stop after a few backoff iterations - no infinite loop, no real sleep
        return stop_event.is_set()

    service._wait = fake_wait
    q = queue.Queue()
    service.subscribe("EURUSD", q)

    assert _wait_for(lambda: len(wait_calls) >= 3)
    assert _wait_for(lambda: "EURUSD" not in service._threads)
    # Backoff must double each time, starting at 1.0.
    assert wait_calls[:3] == [1.0, 2.0, 4.0]


def test_market_closed_state_when_now_fn_reports_weekend():
    hang = threading.Event()
    provider = OneShotProvider([], hang)
    saturday_noon_utc = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)  # a Saturday
    service = MarketDataStreamService(provider, FakeLoop(), now_fn=lambda: saturday_noon_utc)

    stopped = threading.Event()

    def fake_wait(stop_event, timeout):
        stopped.set()
        return True  # pretend the stop event fired so the thread exits immediately after one MARKET_CLOSED check

    service._wait = fake_wait
    q = queue.Queue()
    service.subscribe("EURUSD", q)

    assert _wait_for(lambda: stopped.is_set())
    hang.set()


def test_is_forex_market_open_documented_weekend_boundaries():
    assert is_forex_market_open(datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)) is True  # Wednesday
    assert is_forex_market_open(datetime(2026, 8, 28, 21, 59, tzinfo=timezone.utc)) is True  # Friday just before close
    assert is_forex_market_open(datetime(2026, 8, 28, 22, 0, tzinfo=timezone.utc)) is False  # Friday at close
    assert is_forex_market_open(datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)) is False  # Saturday
    assert is_forex_market_open(datetime(2026, 8, 30, 21, 59, tzinfo=timezone.utc)) is False  # Sunday just before open
    assert is_forex_market_open(datetime(2026, 8, 30, 22, 0, tzinfo=timezone.utc)) is True  # Sunday at open


def test_stale_generation_does_not_dispatch_to_newer_subscription():
    """Regression test for a check-then-act race: a symbol's OLD stream
    thread can be scheduled between its own `stop_event.is_set()` check
    (inside its `for quote in stream_prices(...)` loop) and the dispatch
    call that check guards. In that window, a resubscribe of the SAME
    symbol - routine in dev, since React StrictMode's mount -> cleanup ->
    mount double-invoke does exactly this - can complete, replacing
    `_stop_events`/`_subscribers`/`_aggregators` with a brand-new
    generation. Without the stop_event-identity check inside `_dispatch`/
    `_set_state`/`_process_quote`, the OLD thread's now-stale call would
    still deliver into the NEW subscriber's queue and the NEW aggregator -
    this is not hypothetical, since the loop's own `is_set()` check is
    necessarily separated in time from the call it guards."""
    hang = threading.Event()
    provider = OneShotProvider([], hang)
    service = MarketDataStreamService(provider, FakeLoop(), now_fn=_open_market_now_fn)

    q_old, q_new = queue.Queue(), queue.Queue()
    service.subscribe("EURUSD", q_old)
    assert _wait_for(lambda: "EURUSD" in service._stop_events)
    stale_stop_event = service._stop_events["EURUSD"]

    service.unsubscribe("EURUSD", q_old)
    service.subscribe("EURUSD", q_new)  # new generation: new stop_event/aggregator/subscriber set
    assert service._stop_events["EURUSD"] is not stale_stop_event

    # Simulate the OLD thread reaching its dispatch call using the STALE
    # stop_event it captured at its own creation.
    stale_quote = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.0, ask=1.0002, source="fake")
    service._process_quote("EURUSD", stale_stop_event, stale_quote)

    # q_new legitimately receives the NEW thread's own status messages
    # (e.g. "connecting") from its normal startup - only a "quote"-typed
    # message could have come from the stale _process_quote call above, so
    # that's specifically what must never appear.
    messages = []
    while not q_new.empty():
        messages.append(q_new.get_nowait())
    assert not any(m["type"] == "quote" for m in messages)
    hang.set()
    service.shutdown()


def test_subscribe_rejects_unsupported_symbol():
    hang = threading.Event()
    provider = OneShotProvider([], hang)
    service = MarketDataStreamService(provider, FakeLoop())
    with pytest.raises(ValueError):
        service.subscribe("NOPE", object())
