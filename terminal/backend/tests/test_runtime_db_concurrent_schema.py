"""
Regression test for the confirmed concurrent-schema-creation bug: both
`app/marketdata/repository.py` and `app/backtest/repository.py` called their
own bare loop of `CREATE TABLE IF NOT EXISTS` statements (`ensure_schema`)
against a fresh, uncached connection to the shared `runtime.duckdb` file, on
every single store/read operation. When two threads each open their own
connection and call `ensure_schema()` concurrently - exactly what happens
under FastAPI's threadpool when two requests land close together - DuckDB
raises `duckdb.duckdb.TransactionException: TransactionContext Error:
Catalog write-write conflict on create with "..."`, even though every
statement involved is individually idempotent (`IF NOT EXISTS`): the
conflict is at the transaction/catalog level, not the statement's own
semantics.

The fix: a single, process-wide `threading.Lock()` in `app/runtime_db.py`
(`ensure_schema(con, statements)`), shared by both `app/marketdata/
repository.py`'s and `app/backtest/repository.py`'s own `ensure_schema(con)`
wrappers, since the race is between the two modules just as much as within
either one alone (they write to the same file).

This test drives BOTH modules' `ensure_schema(con)` functions concurrently,
in a mixed pattern, against one shared temp file, and asserts no
`TransactionException` occurs. To confirm this test actually exercises the
bug (not just trusts the fix "should" work): temporarily reverting
`runtime_db.ensure_schema`'s body to a bare unlocked loop (removing the
`with _schema_lock:` guard) reproduces failures here reliably across
repeated runs - see the task notes for the manual before/after
confirmation. Kept in this file as the permanent regression guard, in the
same no-network/temp-DuckDB pattern as `test_service.py`/
`test_marketdata_routes.py`/`test_backtest_repository.py`.
"""
from __future__ import annotations

import threading

import duckdb
import pytest

from app import runtime_db
from app.backtest import repository as backtest_repository
from app.marketdata import repository as marketdata_repository


@pytest.fixture
def shared_runtime_db_path(tmp_path, monkeypatch):
    path = str(tmp_path / "shared_runtime.duckdb")
    monkeypatch.setattr(marketdata_repository, "DB_PATH", path)
    monkeypatch.setattr(backtest_repository, "DB_PATH", path)
    return path


def _ensure_schema_many_times(ensure_schema_fn, get_connection_fn, iterations: int, errors: list):
    for _ in range(iterations):
        con = get_connection_fn()
        try:
            ensure_schema_fn(con)
        except Exception as exc:  # capture from the worker thread so the
            # main thread's assertions can see it - pytest doesn't
            # propagate exceptions raised inside a spawned thread.
            errors.append(exc)
        finally:
            con.close()


def test_concurrent_ensure_schema_across_both_modules_does_not_raise(shared_runtime_db_path):
    """8 threads, mixed between `app/marketdata/repository.py`'s and
    `app/backtest/repository.py`'s own `ensure_schema(con)` entry points,
    each looping `CREATE TABLE IF NOT EXISTS` against ONE shared file.
    Before the fix, this reliably produced
    `duckdb.duckdb.TransactionException` on most threads (reproduced
    directly: 8 threads, 7/8 raised). After the fix (the shared
    `runtime_db._schema_lock`), zero threads should raise."""
    errors: list[Exception] = []
    threads = []

    for i in range(8):
        if i % 2 == 0:
            ensure_schema_fn = marketdata_repository.ensure_schema
            get_connection_fn = marketdata_repository.get_rw_connection
        else:
            ensure_schema_fn = backtest_repository.ensure_schema
            get_connection_fn = backtest_repository.get_rw_connection

        t = threading.Thread(
            target=_ensure_schema_many_times,
            args=(ensure_schema_fn, get_connection_fn, 10, errors),
        )
        threads.append(t)

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], (
        f"Expected zero TransactionException/errors under the fix, got "
        f"{len(errors)}: {errors[:3]!r}"
    )


def test_runtime_db_ensure_schema_directly_under_concurrency(tmp_path):
    """Narrower unit test of `runtime_db.ensure_schema` itself (not routed
    through either repository module), confirming the shared lock alone -
    given the exact statements list `app/marketdata/repository.py` uses -
    is sufficient to prevent the catalog write-write conflict."""
    path = str(tmp_path / "direct_runtime.duckdb")
    statements = marketdata_repository._SCHEMA_STATEMENTS
    errors: list[Exception] = []

    def worker():
        for _ in range(10):
            con = duckdb.connect(path, read_only=False)
            try:
                runtime_db.ensure_schema(con, statements)
            except Exception as exc:
                errors.append(exc)
            finally:
                con.close()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"Expected zero errors, got {len(errors)}: {errors[:3]!r}"
