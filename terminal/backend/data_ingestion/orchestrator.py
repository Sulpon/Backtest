"""
run_ingestion() - the testable, argparse-free core that ties fetcher ->
aggregator -> importer together per symbol, computes what's actually
missing against existing `candles` coverage, and reports progress via a
plain callback. download.py (the CLI) is a thin wrapper around this.

Never resolves db_path from app/db.py's DB_PATH - this module never
imports app/db.py at all, so it can never accidentally touch that module's
cached read-only singleton connection. The caller (download.py) always
passes an explicit path.
"""
from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, Optional

import duckdb
import httpx

from app.marketdata.models import Candle, PriceKind
from app.marketdata.timeframes import TIMEFRAME_SECONDS, aggregate_candles, bucket_start
from app.marketdata.validation import ValidationLevel, validate_candles

from . import cache as cache_module
from .aggregator import aggregate_to_timeframes, ticks_to_1m_candles
from .fetcher import fetch_ticks_for_hour
from .importer import ensure_schema_migration, ensure_symbol_registered, get_coverage, upsert_symbol_timeframe

ProgressCallback = Callable[[str], None]

BASE_TIMEFRAME = "1m"

# Confirmed empirically running the actual POC against the real mirror:
# datafeed.dukascopy.com DOES rate-limit (429), despite having no
# documented SLA. fetcher.py's retry-on-429 handles an occasional hit
# reactively, but a well-behaved client should also avoid triggering it in
# the first place - a small delay between successive REAL (non-cache-hit)
# fetches. Applied unconditionally rather than only on cache misses to
# keep this simple; the added latency on a fully-cached rerun (a fast
# per-iteration no-op check, not a real fetch) is negligible.
_INTER_REQUEST_DELAY_SECONDS = 0.25


def _default_progress(msg: str) -> None:
    print(msg)


@dataclass
class IngestionResult:
    symbol: str
    hours_fetched: int = 0
    ticks_fetched: int = 0
    timeframe_rows_written: dict[str, int] = field(default_factory=dict)
    validation_levels: dict[str, str] = field(default_factory=dict)


def _iter_hours(start: datetime, end: datetime) -> Iterable[datetime]:
    cur = start.replace(minute=0, second=0, microsecond=0)
    while cur < end:
        yield cur
        cur += timedelta(hours=1)


def compute_fetch_ranges(
    start: datetime, end: datetime, coverage: Optional[tuple[int, int]]
) -> list[tuple[datetime, datetime]]:
    """The sub-range(s) of [start, end) that actually need fetching, given
    existing (min_time, max_time) 1m-candle coverage in unix seconds. The
    already-covered middle is never re-fetched - combined with the on-disk
    .bi5 cache, this is what makes an interrupted/rerun invocation cheap:
    only the genuine remainder is ever re-requested."""
    if coverage is None:
        return [(start, end)] if start < end else []
    existing_min = datetime.fromtimestamp(coverage[0], tz=timezone.utc)
    existing_max = datetime.fromtimestamp(coverage[1], tz=timezone.utc) + timedelta(minutes=1)
    ranges: list[tuple[datetime, datetime]] = []
    if start < existing_min:
        ranges.append((start, min(existing_min, end)))
    if end > existing_max:
        ranges.append((max(existing_max, start), end))
    return [r for r in ranges if r[0] < r[1]]


def run_ingestion(
    *,
    symbols: list[str],
    start: datetime,
    end: datetime,
    timeframes: list[str],
    db_path: str,
    cache_dir: str = cache_module.DEFAULT_CACHE_DIR,
    use_cache: bool = True,
    dry_run: bool = False,
    backup: bool = True,
    client: Optional[httpx.Client] = None,
    progress: ProgressCallback = _default_progress,
) -> list[IngestionResult]:
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start >= end:
        raise ValueError(f"start ({start}) must be before end ({end})")
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database file not found: {db_path}")

    # Backup MUST happen before opening any connection to db_path - DuckDB
    # holds an exclusive OS-level lock on a file it has open for writing
    # (and on Windows specifically, shutil.copy2's CopyFile2 cannot copy a
    # file that this same process already holds open), so backing up
    # AFTER connect() would try to copy a file we ourselves are locking -
    # a self-inflicted PermissionError, not a real external conflict. This
    # ordering also means a legitimate "someone else has this file open"
    # conflict is still caught below, just by the connect() attempt itself
    # rather than by the backup step.
    if not dry_run and backup:
        backup_path = f"{db_path}.bak-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
        progress(f"Backing up {db_path} -> {backup_path}")
        shutil.copy2(db_path, backup_path)

    # A read-only connection here (dry_run, or just for planning) is safe
    # to open even while a server holds its own read-only connection to
    # the same file - DuckDB allows multiple simultaneous readers, only a
    # writer conflicts with anything else (test_rw_ro_coexistence.py's own
    # proof). This is a deliberate improvement over "zero DB connection"
    # for dry-run: reading real coverage gives an accurate fetch plan
    # instead of guessing, with no risk to a running server.
    try:
        con = duckdb.connect(db_path, read_only=dry_run)
    except duckdb.Error as exc:
        raise RuntimeError(
            f"Could not open {db_path} for {'reading' if dry_run else 'writing'}. If a dev/prod "
            "server is running against this file, it holds a read-only connection that cannot "
            "coexist with a read-write connection (see test_rw_ro_coexistence.py) - stop the "
            f"server first. Original error: {exc}"
        ) from exc

    results: list[IngestionResult] = []
    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=30.0)

    try:
        if not dry_run:
            ensure_schema_migration(con)

        for symbol in symbols:
            result = IngestionResult(symbol=symbol)
            base_coverage = get_coverage(con, symbol, BASE_TIMEFRAME)
            fetch_ranges = compute_fetch_ranges(start, end, base_coverage)

            if not fetch_ranges:
                progress(f"{symbol}: already fully covered for {start.date()}..{end.date()}, nothing to fetch")
                results.append(result)
                continue

            if dry_run:
                for r_start, r_end in fetch_ranges:
                    hours = list(_iter_hours(r_start, r_end))
                    progress(f"[dry-run] {symbol}: would fetch {len(hours)} hour(s), {r_start} .. {r_end}")
                results.append(result)
                continue

            all_ticks = []
            for r_start, r_end in fetch_ranges:
                hours = list(_iter_hours(r_start, r_end))
                for i, hour in enumerate(hours):
                    ticks = fetch_ticks_for_hour(symbol, hour, client=client, cache_dir=cache_dir, use_cache=use_cache)
                    all_ticks.extend(ticks)
                    result.hours_fetched += 1
                    if (i + 1) % 24 == 0 or i == len(hours) - 1:
                        progress(f"{symbol}: fetched {i + 1}/{len(hours)} hours ({len(all_ticks)} ticks so far)")
                    if i < len(hours) - 1:
                        time.sleep(_INTER_REQUEST_DELAY_SECONDS)

            result.ticks_fetched = len(all_ticks)
            if not all_ticks:
                progress(f"{symbol}: no ticks returned for the requested range (market closed, or genuinely no data)")
                results.append(result)
                continue

            base_1m = ticks_to_1m_candles(all_ticks, symbol)
            by_timeframe = aggregate_to_timeframes(base_1m, timeframes)
            ensure_symbol_registered(con, symbol, symbol)

            for tf, candles in by_timeframe.items():
                validation = validate_candles(candles, TIMEFRAME_SECONDS.get(tf))
                result.validation_levels[tf] = validation.level.value
                if validation.level == ValidationLevel.INVALID:
                    progress(f"{symbol}/{tf}: validation INVALID ({len(validation.issues)} issues) - skipping insert")
                    continue
                written = upsert_symbol_timeframe(con, symbol, tf, candles)
                result.timeframe_rows_written[tf] = written
                progress(f"{symbol}/{tf}: wrote {written} rows (validation: {validation.level.value})")

            results.append(result)
    finally:
        if owns_client:
            client.close()
        con.close()

    return results


def _candle_from_1m_row(symbol: str, row: tuple) -> Candle:
    time_, open_, high, low, close, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close = row
    has_bid_ask = bid_open is not None
    return Candle(
        instrument_id=symbol,
        timeframe=BASE_TIMEFRAME,
        timestamp_utc=time_,
        open=open_,
        high=high,
        low=low,
        close=close,
        # `candles` has no volume column - there is nothing to read back,
        # so this stays None (honest "unknown"), never fabricated.
        bid_open=bid_open,
        bid_high=bid_high,
        bid_low=bid_low,
        bid_close=bid_close,
        ask_open=ask_open,
        ask_high=ask_high,
        ask_low=ask_low,
        ask_close=ask_close,
        # Provenance wasn't stored on `candles` itself (no source/price_kind
        # columns - see importer.py's own scope note on why not) - inferred
        # here from whether bid/ask is actually populated, which is exactly
        # what distinguishes a Dukascopy-sourced row from an older
        # manually-imported CSV row in this table today.
        source="dukascopy" if has_bid_ask else "csv_import",
        price_kind=PriceKind.BID_ASK if has_bid_ask else PriceKind.MID,
    )


def reaggregate_higher_timeframes(
    con: duckdb.DuckDBPyConnection,
    symbol: str,
    timeframes: list[str],
    progress: ProgressCallback = _default_progress,
) -> dict[str, int]:
    """Derives/extends higher-timeframe candles directly from 1m candles
    ALREADY STORED in `candles` - no network fetch, no Dukascopy call, no
    dependency on fetcher.py at all. For each target timeframe, only 1m
    candles whose bucket_start() falls STRICTLY AFTER that timeframe's own
    current MAX(time) are aggregated - this never touches, rewrites, or
    renumbers any existing higher-timeframe row (including independently-
    sourced ones, e.g. build_db.py's own separate per-timeframe CSVs); it
    only ever adds new buckets after them, via upsert_symbol_timeframe's
    fast (append) path. Uses the EXACT SAME bucket_start()/
    aggregate_candles() the rest of the app (historical rollups, the live
    aggregator from an earlier task) already relies on - no second
    bucketing implementation. A timeframe with no new 1m data beyond its
    own coverage is left untouched and reported as 0 rows written, not an
    error - "missing or stale" is determined per-timeframe, independently,
    not as one blanket operation."""
    base_rows = con.execute(
        "SELECT time, open, high, low, close, bid_open, bid_high, bid_low, bid_close, "
        "ask_open, ask_high, ask_low, ask_close FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY time",
        [symbol, BASE_TIMEFRAME],
    ).fetchall()
    base_1m = [_candle_from_1m_row(symbol, r) for r in base_rows]

    written: dict[str, int] = {}
    for tf in timeframes:
        coverage = get_coverage(con, symbol, tf)
        cutoff = coverage[1] if coverage is not None else -1
        relevant = [c for c in base_1m if bucket_start(c.timestamp_utc, tf) > cutoff]
        if not relevant:
            progress(f"{symbol}/{tf}: no new 1m data beyond existing coverage ({cutoff}) - nothing to do")
            written[tf] = 0
            continue

        new_candles = aggregate_candles(relevant, tf)
        validation = validate_candles(new_candles, TIMEFRAME_SECONDS.get(tf))
        if validation.level == ValidationLevel.INVALID:
            progress(f"{symbol}/{tf}: validation INVALID ({len(validation.issues)} issues) - skipping insert")
            written[tf] = 0
            continue

        count = upsert_symbol_timeframe(con, symbol, tf, new_candles)
        written[tf] = count
        progress(f"{symbol}/{tf}: wrote {count} new rows (validation: {validation.level.value})")

    return written
