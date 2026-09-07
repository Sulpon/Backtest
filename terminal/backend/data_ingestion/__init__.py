"""
Programmatic historical-data ingestion from Dukascopy's public tick-file
mirror, replacing the manual MT4-CSV-import workflow build_db.py relied on
for the `candles` table's data source. Downloads raw ticks (bid/ask), builds
1-minute candles ourselves, and reuses app/marketdata/timeframes.py's
aggregate_candles() for every higher timeframe - never a second bucketing
implementation.

Sibling package to app/, build_db.py, sync_market_data.py - same
".venv/Scripts/python.exe", cwd=terminal/backend convention. See
c:\\Users\\sulta\\.claude\\plans\\compiled-munching-pancake.md for the full
design rationale (there is no official Dukascopy API; this reads the same
public, unauthenticated tick-file mirror every unofficial tool - including
Dukascopy's own JForex platform - ultimately uses).
"""
