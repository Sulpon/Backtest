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

import duckdb

RUNTIME_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime.duckdb")


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
