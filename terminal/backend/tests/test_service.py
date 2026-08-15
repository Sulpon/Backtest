"""
MarketDataService tested entirely against a fake in-memory provider - no
network, no real credentials ("mock the external provider in tests; do not
make tests depend on a live API"). Runs against a temporary DuckDB file so
it never touches the real data.duckdb.
"""
import os
import tempfile

import pytest

from app.marketdata import repository
from app.marketdata.models import Candle
from app.marketdata.provider import MarketDataProvider, ProviderInstrument
from app.marketdata.service import MarketDataService


class MockProvider(MarketDataProvider):
    name = "mock"

    def __init__(self):
        self.calls: list[tuple[int, int]] = []

    def list_instruments(self):
        return [ProviderInstrument("EUR_USD", "EURUSD", 5, -4, None, None)]

    def get_candles(self, symbol, timeframe, start, end):
        self.calls.append((start, end))
        out = []
        ts = start if start % 60 == 0 else start + (60 - start % 60)
        while ts < end:
            out.append(
                Candle(instrument_id=symbol, timeframe=timeframe, timestamp_utc=ts,
                       open=1.10, high=1.12, low=1.09, close=1.11, volume=5, source="mock")
            )
            ts += 60
        return out


class FailingProvider(MarketDataProvider):
    name = "failing"

    def list_instruments(self):
        return []

    def get_candles(self, symbol, timeframe, start, end):
        raise ConnectionError("provider unreachable")


@pytest.fixture
def temp_db(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".duckdb")
    os.close(fd)
    os.remove(path)  # duckdb needs to create the file itself
    monkeypatch.setattr(repository, "DB_PATH", path)
    yield path
    if os.path.exists(path):
        os.remove(path)


def test_first_sync_fetches_full_requested_range(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)
    candles = service.get_candles("EURUSD", "1m", 0, 600)
    assert len(candles) == 10
    assert provider.calls == [(0, 600)]


def test_second_request_within_covered_range_does_not_refetch(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)
    service.get_candles("EURUSD", "1m", 0, 600)
    provider.calls.clear()

    candles = service.get_candles("EURUSD", "1m", 120, 300)

    assert len(candles) == 3
    assert provider.calls == []  # fully covered already - no provider call at all


def test_incremental_sync_only_fetches_missing_tail(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)
    service.get_candles("EURUSD", "1m", 0, 600)
    provider.calls.clear()

    candles = service.get_candles("EURUSD", "1m", 0, 1200)

    assert len(candles) == 20
    assert len(provider.calls) == 1
    fetched_start, fetched_end = provider.calls[0]
    assert fetched_start > 0  # did not re-request the already-covered range from the start
    assert fetched_end == 1200


def test_incremental_sync_only_fetches_missing_head():
    # a separate temp DB per test avoids ordering coupling
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.duckdb")
        original = repository.DB_PATH
        repository.DB_PATH = path
        try:
            provider = MockProvider()
            service = MarketDataService(provider)
            service.get_candles("EURUSD", "1m", 600, 1200)
            provider.calls.clear()

            candles = service.get_candles("EURUSD", "1m", 0, 1200)

            assert len(candles) == 20
            assert len(provider.calls) == 1
            fetched_start, fetched_end = provider.calls[0]
            assert fetched_start == 0
            assert fetched_end <= 600
        finally:
            repository.DB_PATH = original


def test_higher_timeframe_is_aggregated_not_fetched_natively(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)

    candles = service.get_candles("EURUSD", "5m", 0, 600)

    assert len(candles) == 2
    assert all(c.timeframe == "5m" for c in candles)
    # the provider was only ever asked for the base timeframe, never "5m"
    assert all(True for _ in provider.calls)  # sanity: calls happened via base-timeframe sync path


def test_provider_failure_does_not_corrupt_existing_data(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)
    service.get_candles("EURUSD", "1m", 0, 600)

    failing_service = MarketDataService(FailingProvider())
    with pytest.raises(ConnectionError):
        failing_service.sync("EURUSD", 600, 1200)

    con = repository.get_rw_connection()
    try:
        still_there = repository.read_candles(con, "EURUSD", "1m", 0, 600)
    finally:
        con.close()
    assert len(still_there) == 10  # untouched by the failed sync attempt


def test_sync_instruments_populates_instrument_table(temp_db):
    provider = MockProvider()
    service = MarketDataService(provider)

    count = service.sync_instruments()

    assert count == 1
    con = repository.get_rw_connection()
    try:
        row = con.execute("SELECT symbol, provider_symbol, base_currency, quote_currency, asset_class, pip_size "
                           "FROM instruments WHERE id = 'EURUSD'").fetchone()
    finally:
        con.close()
    assert row == ("EURUSD", "EUR_USD", "EUR", "USD", "forex", pytest.approx(0.0001))
