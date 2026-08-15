import os
import threading
import duckdb

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data.duckdb")

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
