"""
/ws/market-data - subscribe/unsubscribe protocol and the Vercel-graceful-
degradation path. Uses `with TestClient(main.app) as client:` (the
context-manager form) deliberately - that's what actually runs
`app.router.lifespan_context` (`_marketdata_lifespan`), unlike the plain
`TestClient(main.app)` fixture `test_marketdata_routes.py` uses for its own
(non-lifespan-dependent) tests, which this file leaves untouched.

Runs entirely against MockStreamProvider with a no-op sleep_fn - no
network, no real wall-clock waits.

`stream_service.is_forex_market_open` is monkeypatched to always report
"open" in every test that expects live ticks - `_marketdata_lifespan`
constructs `MarketDataStreamService` with no `now_fn` override (there's no
legitimate production reason for main.py to fake the wall clock), so
without this, whether these tests see any ticks at all would depend on
which day of the week the suite happens to run - exactly the kind of
flakiness test_stream_service.py's own fixed `_OPEN_MARKET_NOW` exists to
avoid at the unit level.
"""
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.marketdata import stream_service
from app.marketdata.providers.mock_stream import MockStreamProvider


def _wait_for(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _fast_mock_provider():
    return MockStreamProvider(seed=1, sleep_fn=lambda _seconds: None)


@pytest.fixture(autouse=True)
def _market_always_open(monkeypatch):
    monkeypatch.setattr(stream_service, "is_forex_market_open", lambda now: True)


def test_websocket_closes_immediately_when_service_unavailable(monkeypatch):
    def raise_error():
        raise RuntimeError("no provider configured")

    monkeypatch.setattr(main, "get_provider", raise_error)

    with TestClient(main.app) as client:
        with pytest.raises(Exception):
            # starlette's TestClient raises a WebSocketDisconnect (or similar)
            # when the server closes the socket right after accept - either
            # way, the connection must not stay open / hang.
            with client.websocket_connect("/ws/market-data") as ws:
                ws.receive_json()


def test_subscribe_then_receive_quote_and_candle_messages(monkeypatch):
    monkeypatch.setattr(main, "get_provider", _fast_mock_provider)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws/market-data") as ws:
            ws.send_json({"action": "subscribe", "symbol": "EURUSD"})

            seen_types = set()
            for _ in range(20):
                message = ws.receive_json()
                seen_types.add(message["type"])
                if message["type"] == "quote":
                    assert message["symbol"] == "EURUSD"
                    assert message["bid"] > 0
                    assert message["ask"] > 0
                    assert message["mid"] == pytest.approx((message["bid"] + message["ask"]) / 2)
                if "quote" in seen_types and "candle" in seen_types:
                    break

            assert "quote" in seen_types
            assert "candle" in seen_types


def test_subscribe_unsupported_symbol_returns_error_message(monkeypatch):
    monkeypatch.setattr(main, "get_provider", _fast_mock_provider)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws/market-data") as ws:
            ws.send_json({"action": "subscribe", "symbol": "NOPE"})
            message = ws.receive_json()
            assert message["type"] == "error"


def test_unsubscribe_stops_the_stream_thread_when_it_was_the_last_subscriber(monkeypatch):
    monkeypatch.setattr(main, "get_provider", _fast_mock_provider)

    with TestClient(main.app) as client:
        service = main.app.state.marketdata_stream_service
        assert service is not None

        with client.websocket_connect("/ws/market-data") as ws:
            ws.send_json({"action": "subscribe", "symbol": "EURUSD"})
            ws.receive_json()  # at least one message arrives while subscribed
            assert _wait_for(lambda: "EURUSD" in service._threads)

            ws.send_json({"action": "unsubscribe", "symbol": "EURUSD"})
            assert _wait_for(lambda: "EURUSD" not in service._threads)
            assert service.get_state("EURUSD") is None


def test_unknown_action_returns_error_message(monkeypatch):
    monkeypatch.setattr(main, "get_provider", _fast_mock_provider)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws/market-data") as ws:
            ws.send_json({"action": "bogus", "symbol": "EURUSD"})
            message = ws.receive_json()
            assert message["type"] == "error"
