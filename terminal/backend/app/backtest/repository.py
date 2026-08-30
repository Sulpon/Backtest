"""
Roadmap Phase 3 Task 4: `backtest_runs`/`backtest_run_trades` schema, living
in the SAME `runtime.duckdb` file `app/marketdata/repository.py` already
writes to (ROADMAP.md's Phase 2 fix decision, item 4, recorded
2026-08-26) - deliberately not a third file.

That decision relies on two independent modules (this one and
`app/marketdata/repository.py`) each opening their own read-write
connection to the same path, potentially concurrently - a RW+RW scenario
distinct from the RO+RW scenario that broke Phase 2 (see
`tests/test_rw_ro_coexistence.py`, which proved RO+RW does NOT coexist).
RW+RW had never been exercised before this task; `tests/
test_backtest_repository.py`'s opening test proves it does coexist (only a
MIXED read_only setting is rejected - see that file for the actual
DuckDB-level proof). Per this task's brief, even with that proof in hand,
every function here still opens a fresh, uncached connection, does its
work, and closes it - never a long-lived/module-level connection - the
same discipline `app/marketdata/repository.py` and `app/runtime_db.py`
already use, to minimize any residual risk beyond what was proven safe.

This module never touches `data.duckdb`'s existing `trades`/`stats`/
`order_blocks` tables (the EURUSD-1h build-time SMC-engine output) -
`backtest_runs`/`backtest_run_trades` are new, separately-named tables for
the general, on-demand engine's runs. Per ROADMAP.md's Trades
source-of-truth rule, a general engine's trades and a Pine script's
self-reported `backtest.recordTrade()` trades are two distinct trade
sources that are never merged - this module only ever stores the former.

This module deliberately does NOT wire into `POST /api/backtest/run` -
whether every run auto-persists, or only explicitly-named ones do, is a
separate, not-yet-made decision. This is schema + store/read functions +
their own direct tests only (Phase 3 Task 4's scope).
"""
from __future__ import annotations

import json
import uuid

import duckdb

from .. import runtime_db
from . import runner

# Kept as a module-level global (rather than inlining
# runtime_db.RUNTIME_DB_PATH everywhere below), for the same reason
# app/marketdata/repository.py does this: it lets tests
# monkeypatch.setattr(repository, "DB_PATH", ...) to point this module at
# an isolated temp file, consistent with the existing pattern used by
# tests/test_service.py and tests/test_marketdata_routes.py.
DB_PATH = runtime_db.RUNTIME_DB_PATH

_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS backtest_runs (
        id VARCHAR PRIMARY KEY,
        name VARCHAR,
        symbol VARCHAR NOT NULL,
        timeframe VARCHAR NOT NULL,
        csv_path VARCHAR NOT NULL,
        strategy VARCHAR NOT NULL,
        rr_ratio DOUBLE NOT NULL,
        config_json VARCHAR NOT NULL,
        validated BOOLEAN NOT NULL,
        validation_status VARCHAR NOT NULL,
        validation_message VARCHAR NOT NULL,
        total INTEGER, wins INTEGER, losses INTEGER,
        win_rate DOUBLE, expectancy DOUBLE, breakeven_wr DOUBLE,
        stats_json VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT current_timestamp
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS backtest_run_trades (
        run_id VARCHAR NOT NULL,
        seq INTEGER NOT NULL,
        direction VARCHAR NOT NULL,
        entry_bar INTEGER NOT NULL,
        entry_price DOUBLE NOT NULL,
        sl DOUBLE NOT NULL,
        tp DOUBLE NOT NULL,
        exit_bar INTEGER NOT NULL,
        result VARCHAR NOT NULL,
        r DOUBLE NOT NULL,
        setup VARCHAR,
        PRIMARY KEY (run_id, seq)
    )
    """,
]


def get_rw_connection() -> duckdb.DuckDBPyConnection:
    # Delegates to runtime_db's single connection-factory implementation,
    # passing this module's own DB_PATH explicitly - same reasoning as
    # app/marketdata/repository.py's identical wrapper.
    return runtime_db.get_rw_connection(DB_PATH)


def ensure_schema(con: duckdb.DuckDBPyConnection) -> None:
    # Delegates to runtime_db's single, process-wide-locked implementation -
    # shared with `app/marketdata/repository.py`, since both modules write
    # DDL to the same `runtime.duckdb` file and the race is between them
    # just as much as within either one alone. See that module's
    # `_schema_lock` docstring for why a bare loop of
    # `CREATE TABLE IF NOT EXISTS` statements is not actually safe under
    # concurrent callers, despite each statement being individually
    # idempotent.
    runtime_db.ensure_schema(con, _SCHEMA_STATEMENTS)


def store_run(
    symbol: str,
    timeframe: str,
    strategy: str,
    rr_ratio: float,
    validation: dict,
    trades: list[dict],
    stats: dict,
    name: str | None = None,
) -> str:
    """Persists one backtest run and its trades in a single unit of work
    (one connection, opened and closed here). Accepts the exact shapes
    `POST /api/backtest/run` already produces:

      - `validation`: {"status": ..., "validated": ..., "message": ...}
        (`app/main.py`'s `BacktestValidation`, `app/backtest/runner.py`'s
        `validation_for()` return value).
      - `trades`: a list of {"dir", "entryBar", "entryPrice", "sl", "tp",
        "exitBar", "result", "r", "setup"} dicts (`app/main.py`'s `Trade`
        model shape - e.g. each `Trade.model_dump()` from a route response).
      - `stats`: {"total", "wins", "losses", "winRate", "expectancy", "rr",
        "breakevenWr", "bySetup"} (`app/main.py`'s `Stats` model shape).

    `csv_path` is not a parameter - it's re-derived from (symbol, timeframe)
    via the same catalog `runner.run()` already resolved it from, since by
    the time a caller has trades/stats to store, that combo has already run
    successfully. `seq` (not `entry_bar`) is each trade's primary-key
    ordinal within this run, so two runs on the same symbol/timeframe never
    collide even when their `entry_bar` values overlap.

    Returns the new run's id (a fresh `uuid4()` string).
    """
    run_id = str(uuid.uuid4())
    csv_path = runner._resolve_csv_path(symbol, timeframe)
    config_json = json.dumps({"rrRatio": rr_ratio})
    stats_json = json.dumps(stats)

    con = get_rw_connection()
    try:
        ensure_schema(con)
        con.execute(
            """
            INSERT INTO backtest_runs (
                id, name, symbol, timeframe, csv_path, strategy, rr_ratio,
                config_json, validated, validation_status, validation_message,
                total, wins, losses, win_rate, expectancy, breakeven_wr, stats_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                run_id, name, symbol, timeframe, csv_path, strategy, rr_ratio,
                config_json, bool(validation["validated"]), validation["status"],
                validation["message"],
                stats.get("total"), stats.get("wins"), stats.get("losses"),
                stats.get("winRate"), stats.get("expectancy"), stats.get("breakevenWr"),
                stats_json,
            ],
        )
        if trades:
            con.executemany(
                """
                INSERT INTO backtest_run_trades (
                    run_id, seq, direction, entry_bar, entry_price, sl, tp,
                    exit_bar, result, r, setup
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        run_id, seq, t["dir"], t["entryBar"], t["entryPrice"],
                        t["sl"], t["tp"], t["exitBar"], t["result"], t["r"],
                        t.get("setup"),
                    )
                    for seq, t in enumerate(trades)
                ],
            )
    finally:
        con.close()
    return run_id


def get_run(run_id: str) -> dict | None:
    """Reads a stored run back, decoding `config_json`/`stats_json` and
    reconstructing `trades` ordered by `seq`. Returns None if `run_id` is
    not found (including when the tables don't exist yet - a fresh
    runtime.duckdb with no runs stored)."""
    con = get_rw_connection()
    try:
        ensure_schema(con)
        row = con.execute(
            """
            SELECT id, name, symbol, timeframe, csv_path, strategy, rr_ratio,
                   config_json, validated, validation_status, validation_message,
                   stats_json, created_at
            FROM backtest_runs WHERE id = ?
            """,
            [run_id],
        ).fetchone()
        if row is None:
            return None

        (
            id_, name, symbol, timeframe, csv_path, strategy, rr_ratio,
            config_json, validated, validation_status, validation_message,
            stats_json, created_at,
        ) = row

        trade_rows = con.execute(
            """
            SELECT direction, entry_bar, entry_price, sl, tp, exit_bar, result, r, setup
            FROM backtest_run_trades WHERE run_id = ? ORDER BY seq
            """,
            [run_id],
        ).fetchall()
    finally:
        con.close()

    trades = [
        {
            "dir": t[0], "entryBar": t[1], "entryPrice": t[2], "sl": t[3],
            "tp": t[4], "exitBar": t[5], "result": t[6], "r": t[7], "setup": t[8],
        }
        for t in trade_rows
    ]

    return {
        "id": id_,
        "name": name,
        "symbol": symbol,
        "timeframe": timeframe,
        "csv_path": csv_path,
        "strategy": strategy,
        "rr_ratio": rr_ratio,
        "config": json.loads(config_json),
        "validation": {
            "status": validation_status,
            "validated": bool(validated),
            "message": validation_message,
        },
        "trades": trades,
        "stats": json.loads(stats_json),
        "created_at": created_at,
    }
