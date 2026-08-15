"""
Read/write access to the market-data tables (instruments, data_sources,
datasets, market_candles, data_sync_jobs) - deliberately separate from
../db.py's read-only connection, since incremental sync needs to write.
The existing SMC-engine tables (candles, swing_points, bos_events, ...) are
never touched from here - this module only ever adds new tables alongside
them (CREATE TABLE IF NOT EXISTS), never migrates or drops anything.
"""
from __future__ import annotations

import os
import uuid

import duckdb

from .models import Candle, PriceKind

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data.duckdb")

_SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS instruments (
        id VARCHAR PRIMARY KEY,           -- canonical symbol, e.g. 'EURUSD'
        symbol VARCHAR NOT NULL,
        provider_symbol VARCHAR,
        base_currency VARCHAR NOT NULL,
        quote_currency VARCHAR NOT NULL,
        asset_class VARCHAR NOT NULL,      -- 'forex' | 'metal'
        tick_size DOUBLE,
        contract_size DOUBLE,
        pip_size DOUBLE,
        timezone VARCHAR DEFAULT 'UTC',
        trading_session VARCHAR,
        provider VARCHAR,
        updated_at TIMESTAMP DEFAULT current_timestamp
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS data_sources (
        id VARCHAR PRIMARY KEY,            -- e.g. 'oanda', 'csv_import'
        kind VARCHAR NOT NULL,             -- 'provider' | 'csv'
        display_name VARCHAR,
        created_at TIMESTAMP DEFAULT current_timestamp
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS datasets (
        id VARCHAR PRIMARY KEY,
        instrument_id VARCHAR NOT NULL,
        timeframe VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        source_id VARCHAR NOT NULL,
        start_time BIGINT NOT NULL,
        end_time BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT current_timestamp,
        updated_at TIMESTAMP DEFAULT current_timestamp,
        version INTEGER NOT NULL DEFAULT 1,
        checksum VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS market_candles (
        instrument_id VARCHAR NOT NULL,
        timeframe VARCHAR NOT NULL,
        timestamp_utc BIGINT NOT NULL,
        open DOUBLE NOT NULL, high DOUBLE NOT NULL, low DOUBLE NOT NULL, close DOUBLE NOT NULL,
        volume BIGINT,
        bid_open DOUBLE, bid_high DOUBLE, bid_low DOUBLE, bid_close DOUBLE,
        ask_open DOUBLE, ask_high DOUBLE, ask_low DOUBLE, ask_close DOUBLE,
        source VARCHAR NOT NULL,
        price_kind VARCHAR NOT NULL,
        PRIMARY KEY (instrument_id, timeframe, timestamp_utc)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS data_sync_jobs (
        id VARCHAR PRIMARY KEY,
        instrument_id VARCHAR NOT NULL,
        timeframe VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        requested_start BIGINT,
        requested_end BIGINT,
        status VARCHAR NOT NULL,           -- 'success' | 'failed'
        candles_synced INTEGER DEFAULT 0,
        validation_level VARCHAR,          -- 'valid' | 'warning' | 'invalid'
        error_message VARCHAR,
        started_at TIMESTAMP,
        finished_at TIMESTAMP
    )
    """,
]


def get_rw_connection() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(DB_PATH, read_only=False)


def ensure_schema(con: duckdb.DuckDBPyConnection) -> None:
    for stmt in _SCHEMA_STATEMENTS:
        con.execute(stmt)


def get_coverage(con: duckdb.DuckDBPyConnection, instrument_id: str, timeframe: str) -> tuple[int, int] | None:
    """The [min, max] timestamp_utc already stored for this series, or None
    if nothing is stored yet - the basis for incremental sync's "only ask
    the provider for what's actually missing"."""
    row = con.execute(
        "SELECT min(timestamp_utc), max(timestamp_utc) FROM market_candles WHERE instrument_id = ? AND timeframe = ?",
        [instrument_id, timeframe],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return (int(row[0]), int(row[1]))


def upsert_candles(con: duckdb.DuckDBPyConnection, candles: list[Candle]) -> int:
    if not candles:
        return 0
    con.executemany(
        """
        INSERT INTO market_candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (instrument_id, timeframe, timestamp_utc) DO UPDATE SET
            open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
            volume = excluded.volume,
            bid_open = excluded.bid_open, bid_high = excluded.bid_high,
            bid_low = excluded.bid_low, bid_close = excluded.bid_close,
            ask_open = excluded.ask_open, ask_high = excluded.ask_high,
            ask_low = excluded.ask_low, ask_close = excluded.ask_close,
            source = excluded.source, price_kind = excluded.price_kind
        """,
        [
            (
                c.instrument_id, c.timeframe, c.timestamp_utc, c.open, c.high, c.low, c.close, c.volume,
                c.bid_open, c.bid_high, c.bid_low, c.bid_close,
                c.ask_open, c.ask_high, c.ask_low, c.ask_close,
                c.source, c.price_kind.value,
            )
            for c in candles
        ],
    )
    return len(candles)


def read_candles(con: duckdb.DuckDBPyConnection, instrument_id: str, timeframe: str, start: int, end: int) -> list[Candle]:
    rows = con.execute(
        "SELECT instrument_id, timeframe, timestamp_utc, open, high, low, close, volume, "
        "bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close, source, price_kind "
        "FROM market_candles WHERE instrument_id = ? AND timeframe = ? AND timestamp_utc >= ? AND timestamp_utc < ? "
        "ORDER BY timestamp_utc",
        [instrument_id, timeframe, start, end],
    ).fetchall()
    return [
        Candle(
            instrument_id=r[0], timeframe=r[1], timestamp_utc=r[2],
            open=r[3], high=r[4], low=r[5], close=r[6], volume=r[7],
            bid_open=r[8], bid_high=r[9], bid_low=r[10], bid_close=r[11],
            ask_open=r[12], ask_high=r[13], ask_low=r[14], ask_close=r[15],
            source=r[16], price_kind=PriceKind(r[17]),
        )
        for r in rows
    ]


def ensure_data_source(con: duckdb.DuckDBPyConnection, source_id: str, kind: str, display_name: str) -> None:
    con.execute(
        "INSERT INTO data_sources VALUES (?, ?, ?, now()) ON CONFLICT (id) DO NOTHING",
        [source_id, kind, display_name],
    )


def upsert_instrument(
    con: duckdb.DuckDBPyConnection,
    *,
    instrument_id: str,
    symbol: str,
    provider_symbol: str,
    base_currency: str,
    quote_currency: str,
    asset_class: str,
    tick_size: float | None,
    pip_size: float | None,
    provider: str,
) -> None:
    con.execute(
        """
        INSERT INTO instruments (id, symbol, provider_symbol, base_currency, quote_currency,
                                  asset_class, tick_size, contract_size, pip_size, timezone,
                                  trading_session, provider, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'UTC', NULL, ?, now())
        ON CONFLICT (id) DO UPDATE SET
            provider_symbol = excluded.provider_symbol, tick_size = excluded.tick_size,
            pip_size = excluded.pip_size, provider = excluded.provider, updated_at = now()
        """,
        [instrument_id, symbol, provider_symbol, base_currency, quote_currency,
         asset_class, tick_size, pip_size, provider],
    )


def record_sync_job(
    con: duckdb.DuckDBPyConnection,
    *,
    instrument_id: str,
    timeframe: str,
    provider: str,
    requested_start: int,
    requested_end: int,
    status: str,
    candles_synced: int,
    validation_level: str | None,
    error_message: str | None,
) -> None:
    con.execute(
        """
        INSERT INTO data_sync_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())
        """,
        [
            str(uuid.uuid4()), instrument_id, timeframe, provider, requested_start, requested_end,
            status, candles_synced, validation_level, error_message,
        ],
    )
