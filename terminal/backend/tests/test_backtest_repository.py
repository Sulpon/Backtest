"""
Roadmap Phase 3 Task 4: `app/backtest/repository.py`'s `backtest_runs`/
`backtest_run_trades` schema and its `store_run()`/`get_run()` functions.

This file opens with the required proof this task's brief demands before
any schema work is trusted: that TWO independent read-write connections to
the SAME DuckDB file path coexist safely in one process. This is a
different question from `tests/test_rw_ro_coexistence.py`'s existing
diagnostic (which proved a MIXED read_only=True + read_only=False pair on
one path does NOT coexist, and that two read_only=True connections DO) -
that file deliberately stays an unmodified historical record and does not
cover RW+RW. Per ROADMAP.md's Phase 2 fix decision (item 4, recorded
2026-08-26), this module's tables live in the same `runtime.duckdb` file
`app/marketdata/repository.py` already writes to, so two different modules
may each open their own read-write connection to that one path, possibly
concurrently - RW+RW must actually be proven, not assumed, before this
schema is built on top of that assumption.

Every test here uses a disposable path under pytest's `tmp_path` - never
the real `runtime.duckdb` - exactly like `tests/test_service.py` and
`tests/test_marketdata_routes.py` already do via `monkeypatch.setattr(...,
"DB_PATH", ...)`. Unlike `test_rw_ro_coexistence.py`'s diagnostic (which
needs a real, populated `data.duckdb` to open read-only against, hence its
`shutil.copy2` of the checked-in file), the RW+RW proof below needs no
pre-existing file at all - both connections create/open it fresh - so the
disposable element here is `tmp_path` itself, not a copy of a real file.
"""
from __future__ import annotations

import duckdb
import pytest

from app.backtest import repository


# ---------------------------------------------------------------------------
# Required first step: prove RW+RW coexistence on the same path.
# ---------------------------------------------------------------------------

def test_two_read_write_connections_to_the_same_path_coexist(tmp_path):
    """Opens TWO separate duckdb.connect(path, read_only=False) connections
    to the SAME file path in one process (mirroring two independent modules
    - this one and app/marketdata/repository.py - each calling their own
    get_rw_connection() against runtime.duckdb) and confirms:

      1. The second connection succeeds (does not raise), unlike the
         RO+RW case test_rw_ro_coexistence.py documents.
      2. Both connections can write - each creates a DIFFERENT table.
      3. Each connection can see the other's committed write when it
         queries for it (DuckDB's default auto-commit mode means each
         execute() completes as its own committed transaction).
    """
    path = str(tmp_path / "runtime_rw_rw_proof.duckdb")

    con_a = duckdb.connect(path, read_only=False)
    con_b = duckdb.connect(path, read_only=False)  # must not raise
    try:
        con_a.execute("CREATE TABLE table_from_a (x INTEGER)")
        con_a.execute("INSERT INTO table_from_a VALUES (1)")

        con_b.execute("CREATE TABLE table_from_b (y INTEGER)")
        con_b.execute("INSERT INTO table_from_b VALUES (2)")

        # con_b sees con_a's committed write, and vice versa.
        assert con_b.execute("SELECT x FROM table_from_a").fetchone() == (1,)
        assert con_a.execute("SELECT y FROM table_from_b").fetchone() == (2,)
    finally:
        con_a.close()
        con_b.close()


def test_rw_rw_writes_are_visible_after_reconnecting(tmp_path):
    """Belt-and-suspenders companion to the above: confirms a write made by
    one RW connection while a second RW connection is simultaneously open
    is durably visible to a brand-new THIRD connection after both original
    connections close - not just visible in-memory to the other live
    connection."""
    path = str(tmp_path / "runtime_rw_rw_durability.duckdb")

    con_a = duckdb.connect(path, read_only=False)
    con_b = duckdb.connect(path, read_only=False)
    try:
        con_a.execute("CREATE TABLE t (v INTEGER)")
        con_a.execute("INSERT INTO t VALUES (42)")
    finally:
        con_a.close()
        con_b.close()

    con_c = duckdb.connect(path, read_only=False)
    try:
        assert con_c.execute("SELECT v FROM t").fetchone() == (42,)
    finally:
        con_c.close()


# ---------------------------------------------------------------------------
# store_run() / get_run() round-trip tests.
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_runtime_db(monkeypatch, tmp_path):
    path = str(tmp_path / "runtime.duckdb")
    monkeypatch.setattr(repository, "DB_PATH", path)
    return path


VALIDATION_OK = {
    "status": "validated",
    "validated": True,
    "message": "EURUSD 1h is validated.",
}

VALIDATION_EXPERIMENTAL = {
    "status": "experimental",
    "validated": False,
    "message": "GBPUSD 1h is experimental.",
}

TRADES = [
    {
        "dir": "long", "entryBar": 100, "entryPrice": 1.1000, "sl": 1.0950,
        "tp": 1.1123, "exitBar": 110, "result": "Win", "r": 2.45, "setup": "A",
    },
    {
        "dir": "short", "entryBar": 200, "entryPrice": 1.1050, "sl": 1.1100,
        "tp": 1.0928, "exitBar": 205, "result": "Lose", "r": -1.0, "setup": "B",
    },
]

STATS = {
    "total": 2, "wins": 1, "losses": 1, "winRate": 50.0, "expectancy": 0.725,
    "rr": 2.45, "breakevenWr": 29.0,
    "bySetup": {
        "A": {"n": 1, "wr": 100.0, "exp": 2.45},
        "B": {"n": 1, "wr": 0.0, "exp": -1.0},
    },
}


def test_store_run_then_get_run_round_trips_every_field(temp_runtime_db):
    run_id = repository.store_run(
        symbol="EURUSD", timeframe="1h", strategy="smc_fib_ote", rr_ratio=2.45,
        validation=VALIDATION_OK, trades=TRADES, stats=STATS, name="my run",
    )

    assert isinstance(run_id, str) and len(run_id) > 0

    got = repository.get_run(run_id)
    assert got is not None

    assert got["id"] == run_id
    assert got["name"] == "my run"
    assert got["symbol"] == "EURUSD"
    assert got["timeframe"] == "1h"
    assert got["strategy"] == "smc_fib_ote"
    assert got["rr_ratio"] == 2.45
    assert got["csv_path"].endswith("EURUSD60 (1).csv")
    assert got["config"] == {"rrRatio": 2.45}
    assert got["validation"] == VALIDATION_OK
    assert got["trades"] == TRADES
    assert got["stats"] == STATS
    assert got["created_at"] is not None


def test_store_run_without_a_name_round_trips_none(temp_runtime_db):
    run_id = repository.store_run(
        symbol="GBPUSD", timeframe="1h", strategy="smc_fib_ote", rr_ratio=1.5,
        validation=VALIDATION_EXPERIMENTAL, trades=[], stats=STATS,
    )

    got = repository.get_run(run_id)
    assert got is not None
    assert got["name"] is None
    assert got["trades"] == []
    assert got["validation"] == VALIDATION_EXPERIMENTAL


def test_get_run_on_unknown_id_returns_none(temp_runtime_db):
    assert repository.get_run("00000000-0000-0000-0000-000000000000") is None


def test_get_run_on_a_fresh_db_with_no_tables_yet_returns_none(temp_runtime_db):
    # No store_run() call yet - the tables don't exist until ensure_schema()
    # runs, which get_run() itself must do defensively.
    assert repository.get_run("anything") is None


def test_two_runs_on_the_same_symbol_timeframe_get_different_ids_and_do_not_collide(
    temp_runtime_db,
):
    """Proves the seq-not-entry_bar primary key choice: two runs on the same
    (symbol, timeframe) with OVERLAPPING entry_bar values must not collide
    on backtest_run_trades' primary key."""
    overlapping_trades = [
        {
            "dir": "long", "entryBar": 50, "entryPrice": 1.10, "sl": 1.09,
            "tp": 1.12, "exitBar": 60, "result": "Win", "r": 2.45, "setup": "A",
        },
    ]

    run_id_1 = repository.store_run(
        symbol="EURUSD", timeframe="1h", strategy="smc_fib_ote", rr_ratio=2.45,
        validation=VALIDATION_OK, trades=overlapping_trades, stats=STATS,
    )
    run_id_2 = repository.store_run(
        symbol="EURUSD", timeframe="1h", strategy="smc_fib_ote", rr_ratio=2.45,
        validation=VALIDATION_OK, trades=overlapping_trades, stats=STATS,
    )

    assert run_id_1 != run_id_2

    got_1 = repository.get_run(run_id_1)
    got_2 = repository.get_run(run_id_2)
    assert got_1["trades"] == overlapping_trades
    assert got_2["trades"] == overlapping_trades


def test_store_run_persists_a_multi_trade_run_in_seq_order(temp_runtime_db):
    run_id = repository.store_run(
        symbol="EURUSD", timeframe="1h", strategy="smc_fib_ote", rr_ratio=2.45,
        validation=VALIDATION_OK, trades=TRADES, stats=STATS,
    )
    got = repository.get_run(run_id)
    assert [t["entryBar"] for t in got["trades"]] == [100, 200]


def test_store_run_and_get_run_use_a_fresh_connection_per_call_not_a_cached_one(
    temp_runtime_db,
):
    """Regression guard for the "one connection per operation, never a
    long-lived one" discipline this module's docstring commits to."""
    con1 = repository.get_rw_connection()
    con2 = repository.get_rw_connection()
    try:
        assert con1 is not con2
    finally:
        con1.close()
        con2.close()
