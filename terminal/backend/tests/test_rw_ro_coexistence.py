"""
Roadmap Phase 3, Task 4's required opening step: prove (or disprove) that
app/db.py's cached, read_only=True singleton connection and a NEW
read-write connection to the SAME data.duckdb file path can coexist safely
in the same process. Nothing in the pre-existing suite ever exercised this
- test_marketdata_routes.py and test_service.py both monkeypatch DB_PATH to
a temp file used by only ONE connection at a time, never two connections to
the same path with different read_only modes.

Safety: this NEVER opens a second connection to the real, checked-in,
git-LFS-tracked data.duckdb. Every test here copies it to a pytest tmp_path
first (via shutil.copy2) and does all connecting/writing/reading against
that copy, which pytest deletes after the test regardless of outcome.

RESULT (recorded 2026-08-26, verified by this file): they do NOT coexist.
DuckDB's Python API caches connections per resolved absolute file path
within a single process, and refuses to open a SECOND connection to a path
that already has an open connection with a DIFFERENT `read_only` setting -
regardless of which one was opened first. This is a hard, deterministic
`duckdb.ConnectionException` raised at connection-open time ("Can't open a
connection to same database file with a different configuration than
existing connections"), not silent corruption and not a data-visibility
question - the second connection simply never opens. Two connections with
the SAME read_only setting (RO+RO, or RW+RW) to the same path do coexist
fine in-process; only a mixed RO/RW pair on one path is rejected.

Per this task's brief: this is the "do NOT coexist safely" branch. No
workaround (e.g. changing db.py's connection mode) is attempted here - that
would touch a stable component (db.py) and needs its own human/
platform-architect decision. This task ends at this diagnostic; see the
task's final report for what was NOT built as a result (app/backtest/
repository.py's schema/store/read functions).
"""
import os
import shutil

import duckdb
import pytest

from app import db as app_db


@pytest.fixture
def db_copy(tmp_path):
    """A private copy of the real, checked-in data.duckdb - never the real
    file itself. tmp_path is unique per test and removed by pytest after."""
    copy_path = str(tmp_path / "data_copy.duckdb")
    shutil.copy2(app_db.DB_PATH, copy_path)
    return copy_path


@pytest.fixture
def reset_app_db_singleton(monkeypatch, db_copy):
    """Points app.db at the copy and forces get_connection() to establish a
    brand-new cached singleton against it (rather than reusing whatever
    real-data.duckdb connection some earlier test in this session may have
    already cached) - this is what makes step 1 of the diagnostic actually
    exercise 'the cached read-only singleton exactly as the running app
    would have it', just against a disposable copy instead of the real
    file. monkeypatch restores both attributes to their prior values after
    the test, so this never leaks the copy's connection into other tests.
    """
    monkeypatch.setattr(app_db, "DB_PATH", db_copy)
    monkeypatch.setattr(app_db, "_base_con", None)
    yield
    # Best-effort: close whatever singleton this test established against
    # the copy before monkeypatch swaps DB_PATH/_base_con back, so the
    # temp file isn't left locked when tmp_path tries to remove it.
    if app_db._base_con is not None:
        try:
            app_db._base_con.close()
        except Exception:
            pass


def test_mixed_read_write_and_read_only_connections_do_not_coexist(
    reset_app_db_singleton, db_copy
):
    """Step 1-2 of the diagnostic: establish db.py's read-only singleton
    exactly as get_connection() would, then attempt a second, NEW
    read-write connection to the same file path, in the same process -
    following app/marketdata/repository.py's own get_rw_connection()
    pattern (a plain duckdb.connect(path, read_only=False), no caching).

    Result: the read-write connect() call itself raises - it never
    reaches step 3 (CREATE TABLE) because the connection never opens.
    """
    ro_cursor = app_db.get_connection()
    assert ro_cursor.execute("SELECT 1").fetchone() == (1,)

    with pytest.raises(duckdb.ConnectionException, match="different configuration"):
        duckdb.connect(db_copy, read_only=False)


def test_order_reversed_read_write_first_then_read_only_also_fails(db_copy):
    """Confirms the incompatibility is symmetric (not an artifact of which
    side opened first) - opening a plain read-write connection first, then
    attempting app.db's read-only mode against the same path, fails too.
    Deliberately does not go through reset_app_db_singleton/app.db here:
    this direction only needs two raw duckdb.connect() calls to prove the
    point, and keeps this test independent of app.db's caching fixture.
    """
    rw_con = duckdb.connect(db_copy, read_only=False)
    try:
        with pytest.raises(duckdb.ConnectionException, match="different configuration"):
            duckdb.connect(db_copy, read_only=True)
    finally:
        rw_con.close()


def test_same_mode_connections_to_the_same_path_do_coexist(db_copy):
    """Control case, so the two failures above are attributable specifically
    to the MIXED read_only setting, not to "a second connection to this
    path at all" being categorically impossible. Two read-only connections
    (mirroring what db.py's own get_connection()/cursor() pattern already
    relies on for concurrent requests) coexist fine."""
    ro1 = duckdb.connect(db_copy, read_only=True)
    try:
        ro2 = duckdb.connect(db_copy, read_only=True)
        ro2.close()
    finally:
        ro1.close()
