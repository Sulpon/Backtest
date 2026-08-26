"""
The regression test that should have existed originally for the Phase 2 fix
(recorded in ROADMAP.md, 2026-08-26): proves `app/db.py`'s cached
`read_only=True` singleton (established the moment any `db.py`-backed route
runs) and `app/marketdata/repository.py`'s read-write connection (now
against a SEPARATE `runtime.duckdb` file, via `app/runtime_db.py`) coexist
in the same process, in the same request path, without the
`duckdb.ConnectionException` demonstrated in `tests/test_rw_ro_coexistence.py`.

Before the fix, both connections targeted the same `data.duckdb` file path,
and DuckDB refuses a second, differently-moded connection to a path that
already has one open - see `test_rw_ro_coexistence.py` for that proof (that
file is a permanent historical record and is not modified here). This test
exercises the actual failure sequence through the real, live routes:
`GET /api/dataset` first (establishes db.py's RO singleton), then
`GET /api/marketdata/candles` (needs repository.py's RW connection) - both
must return 200.

Safety: this NEVER opens the real, checked-in, git-LFS-tracked data.duckdb
read-write. `db_copy` copies it to a pytest tmp_path first (same pattern as
test_rw_ro_coexistence.py's own `db_copy` fixture), and the runtime file is
a brand-new, separate tmp_path file that never existed before this test.
"""
import os
import shutil

import pytest
from fastapi.testclient import TestClient

from app import db as app_db
from app import main
from app import runtime_db
from app.marketdata import repository
from app.marketdata.models import Candle
from app.marketdata.provider import MarketDataProvider, ProviderInstrument


class MockProvider(MarketDataProvider):
    """Same fake in-memory provider pattern as test_marketdata_routes.py -
    no network, deterministic bars."""

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


@pytest.fixture
def db_copy(tmp_path):
    """A private copy of the real, checked-in data.duckdb - never the real
    file itself. tmp_path is unique per test and removed by pytest after."""
    copy_path = str(tmp_path / "data_copy.duckdb")
    shutil.copy2(app_db.DB_PATH, copy_path)
    return copy_path


@pytest.fixture
def separate_runtime_db_path(tmp_path):
    """A brand-new, separate tmp_path file for runtime.duckdb - never the
    same path as db_copy, and never the real terminal/backend/runtime.duckdb."""
    return str(tmp_path / "runtime_copy.duckdb")


@pytest.fixture
def isolated_dbs(monkeypatch, db_copy, separate_runtime_db_path):
    """Points app.db at the data.duckdb copy (resetting its cached RO
    singleton so this test actually establishes a fresh one, exactly as a
    running app would) and points runtime_db/repository at a SEPARATE tmp
    file for the RW side - the exact split the Phase 2 fix introduces."""
    monkeypatch.setattr(app_db, "DB_PATH", db_copy)
    monkeypatch.setattr(app_db, "_base_con", None)
    monkeypatch.setattr(runtime_db, "RUNTIME_DB_PATH", separate_runtime_db_path)
    monkeypatch.setattr(repository, "DB_PATH", separate_runtime_db_path)
    yield
    if app_db._base_con is not None:
        try:
            app_db._base_con.close()
        except Exception:
            pass


@pytest.fixture
def client():
    return TestClient(main.app)


def test_dataset_then_marketdata_candles_both_succeed_in_one_process(
    isolated_dbs, client, monkeypatch
):
    """The exact interaction that broke before the fix: once db.py's
    read-only singleton against data.duckdb is established by a request,
    a subsequent /api/marketdata/candles call (which needs a read-write
    connection) must not fail. With data.duckdb and runtime.duckdb now
    separate files, both requests succeed."""
    monkeypatch.setattr(main, "get_provider", lambda: MockProvider())

    dataset_res = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"})
    assert dataset_res.status_code == 200

    candles_res = client.get(
        "/api/marketdata/candles",
        params={"symbol": "EURUSD", "timeframe": "1m", "start": 0, "end": 600},
    )
    assert candles_res.status_code == 200
    body = candles_res.json()
    assert body["symbol"] == "EURUSD"
    assert len(body["bars"]) == 10

    # And the runtime file actually exists at the separate path, distinct
    # from the data.duckdb copy - proving the RW write really landed
    # somewhere other than the RO-singleton's file.
    assert os.path.exists(runtime_db.RUNTIME_DB_PATH)
    assert runtime_db.RUNTIME_DB_PATH != app_db.DB_PATH
