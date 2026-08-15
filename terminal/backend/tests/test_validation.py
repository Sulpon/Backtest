from app.marketdata.models import Candle
from app.marketdata.validation import ValidationLevel, validate_candles


def _c(ts, o, h, l, c):
    return Candle(instrument_id="EURUSD", timeframe="1h", timestamp_utc=ts, open=o, high=h, low=l, close=c, source="t")


def test_valid_series():
    candles = [_c(0, 1.1, 1.12, 1.09, 1.11), _c(3600, 1.11, 1.13, 1.10, 1.12)]
    result = validate_candles(candles, 3600)
    assert result.level == ValidationLevel.VALID
    assert result.issues == []


def test_high_below_low_is_invalid():
    result = validate_candles([_c(0, 1.1, 1.05, 1.2, 1.1)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "high_below_low" for i in result.issues)


def test_open_outside_range_is_invalid():
    result = validate_candles([_c(0, 2.0, 1.2, 1.0, 1.1)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "open_outside_range" for i in result.issues)


def test_close_outside_range_is_invalid():
    result = validate_candles([_c(0, 1.1, 1.2, 1.0, 2.0)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "close_outside_range" for i in result.issues)


def test_duplicate_timestamp_is_invalid():
    result = validate_candles([_c(0, 1, 1, 1, 1), _c(0, 1, 1, 1, 1)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "duplicate_timestamp" for i in result.issues)


def test_non_monotonic_timestamps_invalid():
    result = validate_candles([_c(3600, 1, 1, 1, 1), _c(0, 1, 1, 1, 1)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "non_monotonic" for i in result.issues)


def test_normal_weekend_gap_is_not_flagged():
    result = validate_candles([_c(0, 1, 1, 1, 1), _c(3600 * 49, 1, 1, 1, 1)], 3600)
    assert not any(i.code == "unexpected_gap" for i in result.issues)
    assert result.level == ValidationLevel.VALID


def test_unusually_long_gap_is_warning_not_invalid():
    result = validate_candles([_c(0, 1, 1, 1, 1), _c(3600 * 200, 1, 1, 1, 1)], 3600)
    assert result.level == ValidationLevel.WARNING
    assert any(i.code == "unexpected_gap" for i in result.issues)


def test_impossible_timestamp_is_invalid():
    result = validate_candles([_c(-5, 1, 1, 1, 1)], 3600)
    assert result.level == ValidationLevel.INVALID
    assert any(i.code == "impossible_timestamp" for i in result.issues)
