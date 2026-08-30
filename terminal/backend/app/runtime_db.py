"""
Runtime, request-path-writable DuckDB file - deliberately separate from
../db.py's `data.duckdb`.

The invariant this module exists to enforce:

- `data.duckdb` (see `app/db.py`) is the immutable, read-only-at-request-time
  build artifact, forever. It is produced offline by `build_db.py` and never
  opened read-write by any FastAPI request handler.
- `runtime.duckdb` (this module) is the only DuckDB file the request path may
  ever open read-write. Anything a live route needs to persist at request
  time (today: `app/marketdata/repository.py`'s provider-synced tables)
  belongs here, never in `data.duckdb`.

Why two files instead of one shared connection: DuckDB refuses a second,
differently-moded connection (`read_only=True` vs `read_only=False`) to a
path that already has an open connection in the same process - see
`tests/test_rw_ro_coexistence.py` for the proof. `app/db.py` caches a
process-wide `read_only=True` singleton against `data.duckdb` for the whole
lifetime of the server, so nothing else may ever open `data.duckdb`
read-write while that process is alive. Making `data.duckdb` itself
read-write process-wide was rejected (see `ROADMAP.md`'s Phase 2 fix
decision, recorded 2026-08-26) because Vercel's serverless filesystem is not
reliably writable, and it would put the primary read path
(`/api/dataset`/`/api/symbols`/`/api/quotes`) at risk to fix a secondary
route. A separate file sidesteps the conflict entirely.

`get_rw_connection()` deliberately returns a fresh, UNCACHED connection per
call - it must NOT be memoized into a module-level singleton the way
`app/db.py`'s read-only connection is. A cached read-write connection would
hold `runtime.duckdb` open (and exclusively locked for writes) for the
server's entire lifetime, which would break anything else that needs to
open the same file independently: `sync_market_data.py` (run as a separate
process), `build_db.py` (a different file entirely, but the same reasoning
applies to keeping connections short-lived), and pytest runs that copy/reset
this file between tests. Callers are expected to open, use, and close (or
let garbage collection close) their own connection per unit of work, the
same way `app/marketdata/repository.py`'s pre-existing `get_rw_connection()`
already did before this file existed.
"""
from __future__ import annotations

import os
import threading

import duckdb

RUNTIME_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime.duckdb")

# Process-wide, shared across every module that ensures a schema against
# `runtime.duckdb` (currently `app/marketdata/repository.py` and
# `app/backtest/repository.py`). DuckDB raises
# `duckdb.duckdb.TransactionException: TransactionContext Error: Catalog
# write-write conflict on create with "..."` when two connections attempt
# concurrent DDL against the same file - even when each statement is
# individually idempotent (`CREATE TABLE IF NOT EXISTS`), the conflict is at
# the transaction/catalog level, not the statement's own semantics. This is
# exactly what FastAPI's threadpool can trigger: two overlapping requests
# (e.g. two `/api/marketdata/candles` calls, or a marketdata call overlapping
# a backtest-run store) each open their own fresh, uncached connection (per
# `get_rw_connection()`'s own contract above) and each call `ensure_schema()`
# on every single store/read operation. There must be exactly ONE lock
# shared across every caller writing to this file - two separate per-module
# locks would defeat the purpose, since the race is between modules just as
# much as within one.
#
# This lock only protects against IN-PROCESS thread concurrency (the
# FastAPI threadpool scenario above). It does NOT protect against two
# SEPARATE OS processes (e.g. `sync_market_data.py` running while the server
# is also live) opening connections to the same file at the same time - that
# remains an existing, separate, lower-probability risk, not addressed by
# this fix.
_schema_lock = threading.Lock()


def get_rw_connection(path: str | None = None) -> duckdb.DuckDBPyConnection:
    """`path` defaults to `RUNTIME_DB_PATH` (looked up fresh on every call,
    not captured at def time, so monkeypatching this module's
    `RUNTIME_DB_PATH` in tests still works). Callers that keep their own
    `DB_PATH` module global for monkeypatch-compatibility reasons (e.g.
    `app/marketdata/repository.py`, which tests already patch directly)
    should pass it explicitly, so this stays the single place the actual
    `duckdb.connect(..., read_only=False)` call lives - never duplicate
    this line elsewhere."""
    return duckdb.connect(path if path is not None else RUNTIME_DB_PATH, read_only=False)


def ensure_schema(con: duckdb.DuckDBPyConnection, statements: list[str]) -> None:
    """Runs `statements` (a list of `CREATE TABLE IF NOT EXISTS` strings)
    under the process-wide `_schema_lock`. See the lock's own docstring
    above for why this is necessary despite every statement already being
    individually idempotent. Every module writing DDL to `runtime.duckdb`
    (`app/marketdata/repository.py`, `app/backtest/repository.py`) must
    route through this single function - never re-implement the loop
    locally, and never introduce a second lock."""
    with _schema_lock:
        for stmt in statements:
            con.execute(stmt)
