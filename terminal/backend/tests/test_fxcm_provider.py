"""
FXCM's candle rows are positional arrays in an easy-to-transpose order
(BidOpen, BidClose, BidHigh, BidLow - not Open/High/Low/Close), so the
row-parsing logic gets its own focused test rather than trusting the
adapter's happy-path alone. No network/auth involved - _row_to_candle is a
pure function.
"""
from app.marketdata.models import PriceKind
from app.marketdata.providers.fxcm import _row_to_candle


def test_row_field_order_is_open_close_high_low_not_open_high_low_close():
    # [timestamp, BidOpen, BidClose, BidHigh, BidLow, AskOpen, AskClose, AskHigh, AskLow, TickQty]
    row = [1_700_000_000, 1.1000, 1.1010, 1.1030, 1.0990, 1.1002, 1.1012, 1.1032, 1.0992, 42]
    candle = _row_to_candle(row, "EURUSD", "1m")

    assert candle.bid_open == 1.1000
    assert candle.bid_close == 1.1010
    assert candle.bid_high == 1.1030
    assert candle.bid_low == 1.0990
    assert candle.ask_open == 1.1002
    assert candle.ask_close == 1.1012
    assert candle.ask_high == 1.1032
    assert candle.ask_low == 1.0992
    assert candle.volume == 42


def test_ohlc_is_bid_ask_midpoint_marked_as_such():
    row = [0, 1.10, 1.11, 1.12, 1.09, 1.10, 1.11, 1.12, 1.09, 5]
    candle = _row_to_candle(row, "EURUSD", "1m")

    # identical bid/ask in this fixture -> midpoint equals both
    assert candle.open == 1.10
    assert candle.high == 1.12
    assert candle.low == 1.09
    assert candle.close == 1.11
    assert candle.price_kind == PriceKind.BID_ASK


def test_ohlc_midpoint_differs_from_either_side_when_spread_is_nonzero():
    row = [0, 1.1000, 1.1000, 1.1000, 1.1000, 1.1002, 1.1002, 1.1002, 1.1002, 1]
    candle = _row_to_candle(row, "EURUSD", "1m")

    assert candle.open == (1.1000 + 1.1002) / 2
    assert candle.bid_open == 1.1000
    assert candle.ask_open == 1.1002


def test_symbol_and_timeframe_pass_through():
    row = [0, 1, 1, 1, 1, 1, 1, 1, 1, 0]
    candle = _row_to_candle(row, "GBPJPY", "1h")
    assert candle.instrument_id == "GBPJPY"
    assert candle.timeframe == "1h"
    assert candle.source == "fxcm"
