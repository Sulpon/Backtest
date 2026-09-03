import os
import threading
import duckdb

def _resolve_db_filename() -> str:
    """Vercel sets VERCEL=1 in every build AND runtime environment it
    controls (a real system env var, not something this repo invents) -
    used here, not a manually-set flag, so there's nothing to misconfigure
    per deployment. Production reads data.deploy.duckdb (all 30 symbols,
    only 1h/4h/1d, no indexes - see export_deploy_db.py's own docstring
    for why: the full data.duckdb is 499MB, comfortably over Vercel's
    225MB function bundle limit once Python's own dependencies are
    counted too). Local dev/tests are completely unaffected - VERCEL is
    never set there, so this always returns exactly what DB_PATH always
    pointed to. A plain function (read fresh each call), not a frozen
    constant, purely so this one decision is unit-testable in isolation
    without touching the module-level DB_PATH/_base_con singleton other
    tests depend on."""
    return "data.deploy.duckdb" if os.environ.get("VERCEL") else "data.duckdb"


DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", _resolve_db_filename())

_base_con: duckdb.DuckDBPyConnection | None = None
_lock = threading.Lock()


def get_connection() -> duckdb.DuckDBPyConnection:
    """A fresh cursor onto the shared read-only database for this call.

    A single DuckDB connection object isn't safe for concurrent use from
    multiple threads, and FastAPI runs each sync endpoint in its own
    threadpool thread - two requests landing at the same time and sharing
    one connection interleaved their execute()/fetchall() calls, which
    silently returned rows from the wrong query (surfaced as an IndexError
    reading a "bars" row that actually held a different query's result).
    cursor() gives each caller its own transaction context on the same
    underlying database file, so concurrent requests stop colliding.
    """
    global _base_con
    if _base_con is None:
        with _lock:
            if _base_con is None:
                if not os.path.exists(DB_PATH):
                    raise RuntimeError(
                        f"{DB_PATH} does not exist yet - run `python build_db.py` from the backend/ directory first."
                    )
                _base_con = duckdb.connect(DB_PATH, read_only=True)
    return _base_con.cursor()
