"""
FxcmProvider.stream_prices() - STRUCTURAL/SHAPE TESTS ONLY, against a fake
socketio.Client. This is explicitly NOT a live-connection test: every
protocol detail exercised here (event names, connect/subscribe ordering,
disconnect detection) is this method's own documented, UNVERIFIED-against-
a-live-account guess (see providers/fxcm.py's module docstring caveats
3-5). These tests only prove the adapter's own code does what it claims to
do against a fake double that behaves the way this adapter ASSUMES a real
FXCM Socket.IO server behaves - never assume they prove the real protocol
guess is correct.
"""
import sys
import types

import pytest

from app.marketdata.config import FxcmConfig
from app.marketdata.providers.fxcm import FxcmProvider


class _FakeHttpxResponse:
    def raise_for_status(self):
        pass


class _FakeHttpxClient:
    """Just enough to satisfy FxcmProvider._authenticate()'s REST polling
    handshake - no real network, no assertions about FXCM's actual REST
    behavior (that's covered by test_fxcm_provider.py already)."""

    def __init__(self):
        self.headers = {}

    def get(self, url, params=None):
        return _FakeHttpxResponse()


class FakeSocketIOClient:
    """Fake double for `socketio.Client()` - records calls, lets a test
    trigger the adapter's own registered `connect`/`price` handlers exactly
    the way python-socketio itself would (`.event`/`.on` decorators;
    `.connect()` synchronously invoking the connect handler, mirroring how
    a real handshake ack fires it)."""

    def __init__(self):
        self.connected = False
        self.connect_calls: list[tuple] = []
        self.emitted: list[tuple] = []
        self.disconnected = False
        self._connect_handler = None
        self._on_handlers: dict[str, object] = {}
        # Ticks to deliver to the "price" handler synchronously once
        # connect() runs - simulates a server that starts pushing ticks
        # right after the handshake.
        self.ticks_on_connect: list[dict] = []

    def event(self, func):
        self._connect_handler = func
        return func

    def on(self, event_name):
        def decorator(func):
            self._on_handlers[event_name] = func
            return func

        return decorator

    def emit(self, event, data=None):
        self.emitted.append((event, data))

    def connect(self, url, **kwargs):
        self.connect_calls.append((url, kwargs))
        self.connected = True
        if self._connect_handler is not None:
            self._connect_handler()
        for tick in self.ticks_on_connect:
            self._on_handlers["price"](tick)

    def disconnect(self):
        self.disconnected = True
        self.connected = False


@pytest.fixture
def fake_sio(monkeypatch):
    fake_client = FakeSocketIOClient()
    fake_module = types.SimpleNamespace(Client=lambda: fake_client)
    monkeypatch.setitem(sys.modules, "socketio", fake_module)
    return fake_client


@pytest.fixture
def provider():
    config = FxcmConfig(access_token="test-token", environment="demo")
    return FxcmProvider(config, client=_FakeHttpxClient())


def test_connect_is_called_with_bearer_header_and_demo_base_url(fake_sio, provider):
    gen = provider.stream_prices(["EURUSD"])
    fake_sio.ticks_on_connect = [{"Symbol": "EUR/USD", "Rates": [1.10, 1.11], "Updated": 0}]

    next(gen)

    assert len(fake_sio.connect_calls) == 1
    url, kwargs = fake_sio.connect_calls[0]
    assert url == "https://api-demo.fxcm.com"
    assert kwargs["headers"]["Authorization"] == "Bearer test-token"


def test_subscribes_using_fxcm_slash_symbol_format_for_every_requested_symbol(fake_sio, provider):
    fake_sio.ticks_on_connect = [{"Symbol": "EUR/USD", "Rates": [1.10, 1.11], "Updated": 0}]
    gen = provider.stream_prices(["EURUSD", "GBPJPY"])

    next(gen)

    emitted_pairs = {data["pairs"] for _event, data in fake_sio.emitted}
    assert emitted_pairs == {"EUR/USD", "GBP/JPY"}
    assert all(event == "subscribe" for event, _data in fake_sio.emitted)


def test_yields_a_normalized_quote_for_a_requested_symbol(fake_sio, provider):
    fake_sio.ticks_on_connect = [{"Symbol": "EUR/USD", "Rates": [1.1000, 1.1002], "Updated": 1_700_000_000_000}]
    gen = provider.stream_prices(["EURUSD"])

    quote = next(gen)

    assert quote.symbol == "EURUSD"
    assert quote.bid == 1.1000
    assert quote.ask == 1.1002
    assert quote.source == "fxcm"


def test_ignores_a_tick_for_a_symbol_that_was_not_requested(fake_sio, provider):
    fake_sio.ticks_on_connect = [
        {"Symbol": "GBP/USD", "Rates": [1.26, 1.27], "Updated": 0},  # not requested - must be dropped
        {"Symbol": "EUR/USD", "Rates": [1.10, 1.11], "Updated": 1},
    ]
    gen = provider.stream_prices(["EURUSD"])

    quote = next(gen)

    assert quote.symbol == "EURUSD"


def test_generator_stops_once_the_socket_reports_disconnected(fake_sio, provider):
    fake_sio.ticks_on_connect = [{"Symbol": "EUR/USD", "Rates": [1.10, 1.11], "Updated": 0}]
    gen = provider.stream_prices(["EURUSD"])

    next(gen)  # consumes the one queued tick
    fake_sio.connected = False  # simulate the underlying socket dropping

    with pytest.raises(StopIteration):
        next(gen)

    assert fake_sio.disconnected is True


def test_malformed_tick_payload_is_dropped_not_raised(fake_sio, provider):
    fake_sio.ticks_on_connect = [
        {"Symbol": "EUR/USD"},  # missing "Rates"/"Updated" - malformed
        {"Symbol": "EUR/USD", "Rates": [1.10, 1.11], "Updated": 0},
    ]
    gen = provider.stream_prices(["EURUSD"])

    quote = next(gen)  # the malformed one is silently skipped, not raised

    assert quote.bid == 1.10
