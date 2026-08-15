import pytest

from app.marketdata.symbols import (
    SUPPORTED_SYMBOLS,
    FOREX_PAIRS,
    METAL_PAIRS,
    from_fxcm_symbol,
    from_oanda_symbol,
    parse_symbol,
    to_fxcm_symbol,
    to_oanda_symbol,
)


def test_28_forex_pairs_plus_two_metals():
    assert len(FOREX_PAIRS) == 28
    assert len(METAL_PAIRS) == 2
    assert len(SUPPORTED_SYMBOLS) == 30
    assert len(set(SUPPORTED_SYMBOLS)) == 30  # no duplicates


def test_all_majors_and_metals_present():
    for sym in ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD", "XAUUSD", "XAGUSD"]:
        assert sym in SUPPORTED_SYMBOLS


def test_parse_symbol_forex():
    parts = parse_symbol("GBPJPY")
    assert parts.base == "GBP"
    assert parts.quote == "JPY"
    assert parts.asset_class == "forex"


def test_parse_symbol_metal():
    parts = parse_symbol("XAUUSD")
    assert parts.base == "XAU"
    assert parts.quote == "USD"
    assert parts.asset_class == "metal"


def test_unsupported_symbol_rejected():
    with pytest.raises(ValueError):
        parse_symbol("BTCUSD")


def test_oanda_symbol_round_trip():
    assert to_oanda_symbol("EURUSD") == "EUR_USD"
    assert from_oanda_symbol("EUR_USD") == "EURUSD"
    assert to_oanda_symbol("XAUUSD") == "XAU_USD"
    assert from_oanda_symbol("XAU_USD") == "XAUUSD"


def test_fxcm_symbol_round_trip():
    assert to_fxcm_symbol("EURUSD") == "EUR/USD"
    assert from_fxcm_symbol("EUR/USD") == "EURUSD"
    assert to_fxcm_symbol("XAUUSD") == "XAU/USD"
    assert from_fxcm_symbol("XAU/USD") == "XAUUSD"
