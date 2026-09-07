"""
MarketQuote's computed fields (mid/spread) and its bid/ask validation, plus
TickNormalizer's provider-specific parsing. No network involved - pure
model/parsing tests, same style as test_timeframes.py/test_validation.py.
"""
import pytest
from pydantic import ValidationError

from app.marketdata.quotes import MarketQuote, TickNormalizer


def test_mid_is_the_average_of_bid_and_ask():
    q = MarketQuote(symbol="EURUSD", timestamp_ms=1_700_000_000_000, bid=1.1000, ask=1.1002, source="mock_stream")
    assert q.mid == pytest.approx(1.1001)


def test_spread_is_ask_minus_bid():
    q = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.1000, ask=1.1002, source="mock_stream")
    assert q.spread == pytest.approx(0.0002)


def test_mid_and_spread_are_not_settable_fields():
    q = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=1.11, source="mock_stream")
    dumped = q.model_dump()
    assert dumped["mid"] == pytest.approx(1.105)
    assert dumped["spread"] == pytest.approx(0.01)
    # Constructing with an extra "mid" kwarg must not let a caller override
    # the derived value - computed_field properties are read-only
    # properties, not real fields, so pydantic's constructor silently
    # ignores an unknown "mid" kwarg (its default extra="ignore" behavior)
    # rather than ever assigning it to the computed property.
    q2 = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=1.11, source="mock_stream", mid=999.0)
    assert q2.mid == pytest.approx(1.105)


def test_rejects_non_positive_bid():
    with pytest.raises(ValidationError):
        MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=0.0, ask=1.10, source="mock_stream")


def test_rejects_non_positive_ask():
    with pytest.raises(ValidationError):
        MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.10, ask=-1.0, source="mock_stream")


def test_never_rejects_a_momentarily_crossed_book():
    # bid > ask - real feeds do this during fast-moving conditions; this
    # must be accepted, not silently "fixed" or rejected.
    q = MarketQuote(symbol="EURUSD", timestamp_ms=0, bid=1.1005, ask=1.1000, source="mock_stream")
    assert q.bid == 1.1005
    assert q.ask == 1.1000
    assert q.spread == pytest.approx(-0.0005)


def test_tick_normalizer_from_mock_sets_source_and_fields():
    q = TickNormalizer.from_mock(symbol="GBPUSD", bid=1.2650, ask=1.2652, timestamp_ms=1_700_000_000_000)
    assert q.symbol == "GBPUSD"
    assert q.bid == 1.2650
    assert q.ask == 1.2652
    assert q.timestamp_ms == 1_700_000_000_000
    assert q.source == "mock_stream"


def test_tick_normalizer_from_fxcm_parses_assumed_wire_shape():
    raw = {"Symbol": "EUR/USD", "Rates": [1.1000, 1.1002, 1.1010, 1.0990], "Updated": 1_700_000_000_123}
    q = TickNormalizer.from_fxcm(raw)
    assert q.symbol == "EURUSD"
    assert q.bid == 1.1000
    assert q.ask == 1.1002
    assert q.timestamp_ms == 1_700_000_000_123
    assert q.source == "fxcm"


def test_tick_normalizer_from_fxcm_maps_metal_symbol():
    raw = {"Symbol": "XAU/USD", "Rates": [2350.0, 2350.5], "Updated": 0}
    q = TickNormalizer.from_fxcm(raw)
    assert q.symbol == "XAUUSD"
