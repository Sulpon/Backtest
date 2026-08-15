from app.marketdata.models import Candle
from app.marketdata.timeframes import aggregate_candles


def _c(ts, o, h, l, c, volume=10):
    return Candle(instrument_id="EURUSD", timeframe="1m", timestamp_utc=ts, open=o, high=h, low=l, close=c,
                  volume=volume, source="test")


def test_aggregate_1m_to_5m_ohlc():
    base = [
        _c(0, 1.10, 1.11, 1.09, 1.105),
        _c(60, 1.105, 1.12, 1.10, 1.115),
        _c(120, 1.115, 1.13, 1.11, 1.12),
        _c(180, 1.12, 1.125, 1.10, 1.108),
        _c(240, 1.108, 1.115, 1.095, 1.10),
    ]
    out = aggregate_candles(base, "5m")
    assert len(out) == 1
    bucket = out[0]
    assert bucket.open == 1.10  # first candle's open
    assert bucket.high == 1.13  # max high across all members
    assert bucket.low == 1.09  # min low across all members (the first candle's, not the last's)
    assert bucket.close == 1.10  # last candle's close
    assert bucket.volume == 50  # sum
    assert bucket.timestamp_utc == 0
    assert bucket.timeframe == "5m"


def test_aggregate_respects_bucket_boundaries():
    base = [_c(0, 1, 2, 0.5, 1.5), _c(299, 1.5, 2.5, 1, 2), _c(300, 2, 3, 1.5, 2.5)]
    out = aggregate_candles(base, "5m")
    assert len(out) == 2
    assert out[0].timestamp_utc == 0
    assert out[1].timestamp_utc == 300


def test_aggregate_missing_volume_does_not_fabricate_sum():
    base = [_c(0, 1, 1, 1, 1, volume=10), _c(60, 1, 1, 1, 1, volume=None)]
    out = aggregate_candles(base, "5m")
    assert out[0].volume is None  # can't sum a real count with a missing one and call it real


def test_aggregate_preserves_bid_ask_when_present():
    base = [
        Candle(instrument_id="EURUSD", timeframe="1m", timestamp_utc=0, open=1.1, high=1.11, low=1.09, close=1.10,
               bid_open=1.099, bid_high=1.109, bid_low=1.089, bid_close=1.099,
               ask_open=1.101, ask_high=1.111, ask_low=1.091, ask_close=1.101, source="test"),
        Candle(instrument_id="EURUSD", timeframe="1m", timestamp_utc=60, open=1.10, high=1.12, low=1.10, close=1.115,
               bid_open=1.099, bid_high=1.119, bid_low=1.099, bid_close=1.114,
               ask_open=1.101, ask_high=1.121, ask_low=1.101, ask_close=1.116, source="test"),
    ]
    out = aggregate_candles(base, "5m")
    assert out[0].bid_high == 1.119
    assert out[0].ask_low == 1.091
    assert out[0].bid_open == 1.099  # first member's open
    assert out[0].ask_close == 1.116  # last member's close


def test_base_timeframe_is_passthrough():
    base = [_c(0, 1, 1, 1, 1)]
    assert aggregate_candles(base, "1m") == base


def test_month_aggregation_buckets_by_calendar_month():
    jan_1 = 1_735_689_600  # 2025-01-01T00:00:00Z
    jan_31 = 1_738_281_600  # 2025-01-31T00:00:00Z (still January)
    feb_1 = 1_738_368_000  # 2025-02-01T00:00:00Z
    base = [_c(jan_1, 1, 1, 1, 1), _c(jan_31, 1, 1, 1, 1), _c(feb_1, 1, 1, 1, 1)]
    out = aggregate_candles(base, "1mo")
    assert len(out) == 2
    assert out[0].timestamp_utc == jan_1
    assert out[1].timestamp_utc == feb_1
