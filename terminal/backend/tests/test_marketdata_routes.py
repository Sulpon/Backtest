"""
/api/marketdata/status and /api/marketdata/candles - the FastAPI-layer wiring
added in Roadmap Phase 2 to connect app/marketdata/* (previously reachable
only via sync_market_data.py) to the live API. Tested entirely against a
fake in-memory provider (same approach as test_service.py) and a temp
DuckDB file, so this never touches the real data.duckdb or a live broker.

Deliberately does NOT test /api/dataset here - test_dataset_windowing.py
already covers it, and this file's job is to prove the new routes are
additive (don't need /api/dataset's static dataset to exist, don't change
its behavior).
"""
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

from app import main
from app.marketdata import repository
from app.marketdata.config import MarketDataConfigError
from app.marketdata.models import Candle
from app.marketdata.provider import MarketDataProvider, ProviderInstrument


class MockProvider(MarketDataProvider):
    name = "mock"

    def list_instruments(self):
        return [ProviderInstrument("EUR_USD", "EURUSD", 5, -4, None, None)]

    def get_candles(self, symbol, timeframe, start, end):
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


@pytest.fixture
def client():
    return TestClient(main.app)


def test_status_reports_configured_when_provider_available(client, monkeypatch):
    monkeypatch.setattr(main, "get_provider_name", lambda: "mock")
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get("/api/marketdata/status")

    assert res.status_code == 200
    assert res.json() == {"provider": "mock", "configured": True, "error": None}


def test_status_reports_not_configured_without_credentials(client, monkeypatch):
    monkeypatch.setattr(main, "get_provider_name", lambda: "oanda")

    def raise_config_error():
        raise MarketDataConfigError("OANDA_API_KEY and OANDA_ACCOUNT_ID must be set")

    monkeypatch.setattr(main, "get_provider", raise_config_error)

    res = client.get("/api/marketdata/status")

    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "oanda"
    assert body["configured"] is False
    assert "OANDA_API_KEY" in body["error"]


def test_candles_happy_path_returns_bars_from_the_provider(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "1m", "start": 0, "end": 600},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["symbol"] == "EURUSD"
    assert body["timeframe"] == "1m"
    assert body["provider"] == "mock"
    assert len(body["bars"]) == 10
    assert body["bars"][0] == {"time": 0, "open": 1.10, "high": 1.12, "low": 1.09, "close": 1.11}


def test_candles_second_request_reuses_incremental_sync(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    client.get("/api/marketdata/candles", params={"symbol": "EURUSD", "timeframe": "1m", "start": 0, "end": 600})
    res = client.get("/api/marketdata/candles", params={"symbol": "EURUSD", "timeframe": "1m", "start": 120, "end": 300})

    assert res.status_code == 200
    assert len(res.json()["bars"]) == 3


def test_candles_aggregates_to_a_higher_timeframe(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "5m", "start": 0, "end": 600},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["timeframe"] == "5m"
    assert len(body["bars"]) == 2


def test_candles_rejects_unsupported_symbol(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "NOPE", "timeframe": "1m", "start": 0, "end": 600},
    )

    assert res.status_code == 404


def test_candles_rejects_unknown_timeframe(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "3m", "start": 0, "end": 600},
    )

    assert res.status_code == 400


def test_candles_rejects_end_not_after_start(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "1m", "start": 600, "end": 600},
    )

    assert res.status_code == 400


def test_candles_returns_503_when_provider_not_configured(client, monkeypatch, temp_db):
    def raise_config_error():
        raise MarketDataConfigError("FXCM_ACCESS_TOKEN must be set")

    monkeypatch.setattr(main, "get_provider", raise_config_error)

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "1m", "start": 0, "end": 600},
    )

    assert res.status_code == 503
    assert "FXCM_ACCESS_TOKEN" in res.json()["detail"]


def test_candles_returns_502_on_provider_network_failure(client, monkeypatch, temp_db):
    monkeypatch.setattr(main, "get_provider", lambda: FailingProvider())

    res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "1m", "start": 0, "end": 600},
    )

    assert res.status_code == 502
