"""
CandleAggregator: bucket rollover per LIVE_TIMEFRAMES, and agreement with
timeframes.py's own bucket_start() (the same function both the live and
historical paths use, so a live bucket boundary and a historical one can
never disagree).
"""
import pytest

from app.marketdata.aggregator import LIVE_TIMEFRAMES, CandleAggregator
from app.marketdata.models import PriceKind
from app.marketdata.quotes import MarketQuote
from app.marketdata.timeframes import bucket_start


def _q(ts_ms, bid, ask, symbol="EURUSD"):
    return MarketQuote(symbol=symbol, timestamp_ms=ts_ms, bid=bid, ask=ask, source="mock_stream")


def test_first_quote_opens_a_current_candle_for_every_live_timeframe():
    agg = CandleAggregator("EURUSD")
    confirmed = agg.on_quote(_q(0, 1.0999, 1.1001))

    assert confirmed == []
    for tf in LIVE_TIMEFRAMES:
        candle = agg.current_candle(tf)
        assert candle is not None
        assert candle.timeframe == tf
        assert candle.open == candle.high == candle.low == candle.close == pytest.approx(1.1000)
        assert candle.price_kind == PriceKind.MID
        assert candle.bid_open is None and candle.ask_open is None
        assert candle.timestamp_utc == bucket_start(0, tf)


def test_second_quote_in_the_same_bucket_updates_high_low_close_not_open():
    agg = CandleAggregator("EURUSD")
    agg.on_quote(_q(0, 1.0999, 1.1001))  # mid 1.1000
    agg.on_quote(_q(10_000, 1.1049, 1.1051))  # mid 1.1050, still within the same 1m/5m/... bucket

    m1 = agg.current_candle("1m")
    assert m1.open == pytest.approx(1.1000)
    assert m1.high == pytest.approx(1.1050)
    assert m1.low == pytest.approx(1.1000)
    assert m1.close == pytest.approx(1.1050)


def test_quote_in_a_new_1m_bucket_confirms_the_old_1m_candle_only():
    agg = CandleAggregator("EURUSD")
    agg.on_quote(_q(0, 1.0999, 1.1001))  # bucket 0 for every timeframe
    confirmed = agg.on_quote(_q(61_000, 1.1049, 1.1051))  # 61s later - new 1m bucket, same 5m/15m/... bucket

    confirmed_tfs = {c.timeframe for c in confirmed}
    assert confirmed_tfs == {"1m"}
    old_1m = confirmed[0]
    assert old_1m.timestamp_utc == 0
    assert old_1m.close == pytest.approx(1.1000)  # confirmed with its OWN last price, not the new tick's

    new_1m = agg.current_candle("1m")
    assert new_1m.timestamp_utc == 60
    assert new_1m.open == pytest.approx(1.1050)

    # 5m bucket didn't roll over - still the original bucket, now updated
    five_m = agg.current_candle("5m")
    assert five_m.timestamp_utc == 0
    assert five_m.high == pytest.approx(1.1050)


def test_a_late_tick_for_an_already_superseded_bucket_is_dropped():
    agg = CandleAggregator("EURUSD")
    agg.on_quote(_q(0, 1.0999, 1.1001))
    agg.on_quote(_q(61_000, 1.20, 1.21))  # rolls 1m over to bucket 60, mid ~1.205
    rolled_over_1m = agg.current_candle("1m")

    # A tick timestamped back in bucket 0 arrives after the bucket already moved on.
    late_confirmed = agg.on_quote(_q(5_000, 1.30, 1.31))

    assert late_confirmed == []  # nothing newly confirmed - the late tick was dropped, not applied
    assert agg.current_candle("1m") == rolled_over_1m  # unchanged


def test_on_quote_for_a_different_symbol_raises():
    agg = CandleAggregator("EURUSD")
    with pytest.raises(ValueError):
        agg.on_quote(_q(0, 1.10, 1.11, symbol="GBPUSD"))


def test_current_candle_is_none_before_any_quote():
    agg = CandleAggregator("EURUSD")
    assert agg.current_candle("1h") is None
