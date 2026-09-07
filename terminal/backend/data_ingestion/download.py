"""
CLI entry point:
    python -m data_ingestion.download --symbol EURUSD --start 2020-01-01 --end 2026-08-31
    python -m data_ingestion.download --all-symbols --start 2020-01-01 --end 2026-08-31

Thin argparse wrapper around orchestrator.run_ingestion() - all real logic
lives there so it stays testable without going through argv/subprocess.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

from app.marketdata.symbols import SUPPORTED_SYMBOLS
from app.marketdata.timeframes import TIMEFRAME_SECONDS

from . import cache as cache_module
from .orchestrator import run_ingestion

_DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data.duckdb")
_ALL_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]


def _parse_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _parse_timeframes(value: str) -> list[str]:
    tfs = [tf.strip() for tf in value.split(",") if tf.strip()]
    for tf in tfs:
        if tf not in TIMEFRAME_SECONDS:
            raise argparse.ArgumentTypeError(f"Unknown timeframe '{tf}'")
    return tfs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m data_ingestion.download",
        description="Download historical Forex/metals data from Dukascopy's public tick-file mirror "
        "and populate data.duckdb's `candles` table.",
    )
    symbol_group = parser.add_mutually_exclusive_group(required=True)
    symbol_group.add_argument("--symbol", action="append", dest="symbols", metavar="SYMBOL", help="Repeatable.")
    symbol_group.add_argument("--all-symbols", action="store_true", help=f"All {len(SUPPORTED_SYMBOLS)} supported symbols.")
    parser.add_argument("--start", required=True, type=_parse_date, help="UTC date, YYYY-MM-DD (inclusive).")
    parser.add_argument("--end", required=True, type=_parse_date, help="UTC date, YYYY-MM-DD (exclusive).")
    parser.add_argument("--timeframes", type=_parse_timeframes, default=_ALL_TIMEFRAMES)
    parser.add_argument("--db-path", default=os.path.normpath(_DEFAULT_DB_PATH))
    parser.add_argument("--cache-dir", default=cache_module.DEFAULT_CACHE_DIR)
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--backup", dest="backup", action="store_true", default=True)
    parser.add_argument("--no-backup", dest="backup", action="store_false")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    symbols = list(SUPPORTED_SYMBOLS) if args.all_symbols else args.symbols
    for s in symbols:
        if s not in SUPPORTED_SYMBOLS:
            print(f"error: unsupported symbol '{s}'", file=sys.stderr)
            return 2

    try:
        results = run_ingestion(
            symbols=symbols,
            start=args.start,
            end=args.end,
            timeframes=args.timeframes,
            db_path=args.db_path,
            cache_dir=args.cache_dir,
            use_cache=not args.no_cache,
            dry_run=args.dry_run,
            backup=args.backup,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print("\n--- Summary ---")
    for r in results:
        print(f"{r.symbol}: {r.hours_fetched} hour(s) fetched, {r.ticks_fetched} ticks")
        for tf, written in r.timeframe_rows_written.items():
            print(f"  {tf}: {written} rows written (validation: {r.validation_levels.get(tf)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
