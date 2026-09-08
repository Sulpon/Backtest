"""
Writes Candle batches into `candles` (data.duckdb) - the SAME table
build_db.py has always populated manually, now also populated
programmatically from Dukascopy. Every write here is scoped strictly to
`WHERE symbol=? AND timeframe=?` - never touching any other partition,
symbol, timeframe, or table (swing_points/bos_events/etc. are structure-
engine output, never written by this module) - this scoping is what makes
a run against the real database file safe by construction, not just by
copy-testing luck.

No new tracking table for "what's already downloaded" - coverage is
derived from `candles` itself via MIN(time)/MAX(time) per (symbol,
timeframe), the same concept app/marketdata/repository.py's get_coverage()
already established for market_candles. A separate tracker could drift out
of sync with the actual data (e.g. a crash after insert but before
updating the tracker); deriving from the data itself cannot.
"""
from __future__ import annotations

import duckdb

from app.marketdata.models import Candle

# Exactly these 8 columns - deliberately not also source/price_kind (a
# natural parallel, but outside what was actually approved for this
# schema change). Existing (manually-imported) rows get NULL for all 8 -
# never backfilled/fabricated. Column names match market_candles'
# existing bid_*/ask_* convention for cross-table consistency.
_BID_ASK_COLUMNS = (
    "bid_open", "bid_high", "bid_low", "bid_close",
    "ask_open", "ask_high", "ask_low", "ask_close",
)

_INSERT_COLUMNS = (
    "symbol", "timeframe", "bar_index", "time", "open", "high", "low", "close", "volume", *_BID_ASK_COLUMNS
)
_INSERT_SQL = (
    f"INSERT INTO candles ({', '.join(_INSERT_COLUMNS)}) VALUES ({', '.join('?' for _ in _INSERT_COLUMNS)})"
)


def ensure_schema_migration(con: duckdb.DuckDBPyConnection) -> None:
    """Idempotent - safe to call on every CLI invocation. DuckDB's
    ADD COLUMN IF NOT EXISTS is a no-op after the first real run."""
    for col in _BID_ASK_COLUMNS:
        con.execute(f"ALTER TABLE candles ADD COLUMN IF NOT EXISTS {col} DOUBLE")


def ensure_symbol_registered(con: duckdb.DuckDBPyConnection, symbol: str, label: str) -> None:
    """/api/dataset 404s if `symbol` isn't in the `symbols` table
    (main.py's own existence check), independent of whether `candles` has
    rows for it. `symbols.symbol` already has a PRIMARY KEY (build_db.py),
    so ON CONFLICT DO NOTHING is valid with no migration needed."""
    con.execute("INSERT INTO symbols VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING", [symbol, label])


def get_coverage(con: duckdb.DuckDBPyConnection, symbol: str, timeframe: str) -> tuple[int, int] | None:
    """[min, max] `time` already stored for this (symbol, timeframe), or
    None if nothing is stored yet - mirrors repository.py's get_coverage()
    concept, adapted to `candles`' schema (no shared code: `candles` has no
    PK/unique index to hang an ON CONFLICT off, so the write path itself
    necessarily differs)."""
    row = con.execute(
        "SELECT min(time), max(time) FROM candles WHERE symbol = ? AND timeframe = ?", [symbol, timeframe]
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0]), int(row[1])


def _next_bar_index(con: duckdb.DuckDBPyConnection, symbol: str, timeframe: str) -> int:
    row = con.execute(
        "SELECT max(bar_index) FROM candles WHERE symbol = ? AND timeframe = ?", [symbol, timeframe]
    ).fetchone()
    return 0 if row is None or row[0] is None else int(row[0]) + 1


def _candle_bid_ask_tuple(c: Candle) -> tuple:
    return (c.bid_open, c.bid_high, c.bid_low, c.bid_close, c.ask_open, c.ask_high, c.ask_low, c.ask_close)


def upsert_symbol_timeframe(con: duckdb.DuckDBPyConnection, symbol: str, timeframe: str, new_candles: list[Candle]) -> int:
    """Idempotent insertion - rerunning with the same (or overlapping)
    candles never produces duplicate rows. Returns the number of rows
    written (post-merge total for the slow path, len(new_candles) for the
    fast path - see each branch)."""
    if not new_candles:
        return 0
    new_sorted = sorted(new_candles, key=lambda c: c.timestamp_utc)
    coverage = get_coverage(con, symbol, timeframe)

    # Fast path: pure forward-append (the common "keep it fresh" rerun
    # case) - every new candle is strictly newer than anything stored, so
    # no merge/reindex is needed, just append with bar_index continuing.
    if coverage is not None and new_sorted[0].timestamp_utc > coverage[1]:
        next_idx = _next_bar_index(con, symbol, timeframe)
        rows = [
            (symbol, timeframe, next_idx + i, c.timestamp_utc, c.open, c.high, c.low, c.close, c.volume, *_candle_bid_ask_tuple(c))
            for i, c in enumerate(new_sorted)
        ]
        con.executemany(_INSERT_SQL, rows)
        return len(rows)

    # Slow path: first-ever population, backfill, or any timestamp overlap
    # with what's already stored - merge by timestamp (new candles win on
    # an exact-timestamp collision, since Dukascopy bid/ask data is
    # strictly more complete than an older plain-OHLC CSV row for the same
    # minute, and a freshly-computed Dukascopy tick-count is more granular
    # than an older broker-CSV tick-count for that same minute), then
    # rebuild the whole (symbol, timeframe) partition with bar_index fully
    # renumbered 0..N-1 chronologically - the only approach that stays
    # correct regardless of insertion direction.
    #
    # `volume` is carried through both sides of this merge deliberately:
    # an existing row not touched by `new_sorted` keeps exactly the volume
    # it already had (selected below, passed through unchanged via
    # tuple(r[1:])) - it must never silently become NULL just because the
    # partition happens to get rebuilt. A row that DOES collide with a new
    # candle gets that candle's own volume, same as its OHLC/bid-ask.
    existing_rows = con.execute(
        "SELECT time, open, high, low, close, volume, bid_open, bid_high, bid_low, bid_close, "
        "ask_open, ask_high, ask_low, ask_close FROM candles WHERE symbol = ? AND timeframe = ?",
        [symbol, timeframe],
    ).fetchall()
    merged: dict[int, tuple] = {r[0]: tuple(r[1:]) for r in existing_rows}
    for c in new_sorted:
        merged[c.timestamp_utc] = (c.open, c.high, c.low, c.close, c.volume, *_candle_bid_ask_tuple(c))
    ordered_times = sorted(merged.keys())
    rows = [(symbol, timeframe, i, t, *merged[t]) for i, t in enumerate(ordered_times)]

    con.execute("BEGIN TRANSACTION")
    try:
        con.execute("DELETE FROM candles WHERE symbol = ? AND timeframe = ?", [symbol, timeframe])
        con.executemany(_INSERT_SQL, rows)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return len(rows)
