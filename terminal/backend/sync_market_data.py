"""
Manual entry point for Milestone 1/2 verification: syncs one symbol's base
(1m) candles for a date range from the configured provider into
data.duckdb, via the exact same MarketDataService path the application
will eventually use. Creates the market-data tables (instruments,
data_sources, datasets, market_candles, data_sync_jobs) alongside the
existing SMC-engine tables if they don't exist yet - never touches those.

Usage (from terminal/backend, with .env filled in - see .env.example):
    .venv/Scripts/python.exe sync_market_data.py EURUSD 2026-07-01 2026-08-01
"""
import sys
from datetime import datetime, timezone

from app.marketdata.config import get_provider
from app.marketdata.service import MarketDataService


def to_unix(date_str: str) -> int:
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    symbol, start_str, end_str = sys.argv[1], sys.argv[2], sys.argv[3]
    start, end = to_unix(start_str), to_unix(end_str)

    provider = get_provider()
    print(f"Provider: {provider.name}")

    service = MarketDataService(provider)

    print("Syncing instrument metadata...")
    n = service.sync_instruments()
    print(f"  {n} instruments upserted")

    print(f"Syncing {symbol} 1m candles: {start_str} -> {end_str} ...")
    stored = service.sync(symbol, start, end)
    print(f"  {stored} new candles stored")

    candles = service.get_candles(symbol, "1h", start, end)
    print(f"Verification: {len(candles)} aggregated 1h candles now available for {symbol}")
    if candles:
        print(f"  first: {candles[0]}")
        print(f"  last:  {candles[-1]}")


if __name__ == "__main__":
    main()
