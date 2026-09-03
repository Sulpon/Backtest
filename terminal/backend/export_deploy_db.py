"""
data.duckdb -> data.deploy.duckdb: a smaller, PRODUCTION-ONLY artifact.

Why this exists: Vercel serverless functions have a hard 225MB bundled-
function-size limit. data.duckdb (all 30 symbols, all 7 timeframes, every
SMC structure-engine table, 8 CREATE INDEX statements) is 499MB - a real
deployment tried to ship it and Vercel rejected the build outright
("Total bundle size (549.57 MB) exceeds the maximum function size
(225 MB)"). Measured empirically (see the investigation this script came
out of): the 8 indexes alone account for ~222MB of that (DuckDB ART
indexes on these composite keys are large relative to the data - the
read path's WHERE symbol=? AND timeframe=? already prunes well via
zonemaps on this physically-per-series-contiguous data, so the indexes
buy little for what they cost). Even without them, all 30 symbols x all
7 timeframes is too close to the ~175MB budget that's left after
Python's own dependencies (fastapi/pydantic/duckdb's bundled engine,
~50MB) to be a safe long-term margin.

This script produces the artifact that's actually deployed: all 30
symbols, but only the 1h/4h/1d timeframes (measured at ~60MB, comfortable
headroom) - explicitly approved by the human as the tradeoff (full
1m/5m/15m/30m data stays available locally and in data.duckdb; only the
deployed production app's coverage is narrower). Never creates the 8
indexes build_db.py does. Never modifies data.duckdb (opened read-only) -
this is a pure derivation, safe to re-run any time build_db.py's output
changes.

Usage:
    .venv/Scripts/python.exe export_deploy_db.py
"""
import os
import sys

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_DB_PATH = os.path.join(HERE, "data.duckdb")
DEPLOY_DB_PATH = os.path.join(HERE, "data.deploy.duckdb")

# The timeframes actually served in production - a human product decision
# (which granularity matters enough to ship for 30 symbols), not a
# technical default. Change only with the same explicit sign-off this
# choice itself required.
DEPLOY_TIMEFRAMES = ("1h", "4h", "1d")

# Every table keyed by (symbol, timeframe) - filtered identically. Tables
# with no timeframe column (symbols, order_blocks, trades, stats) are
# copied in full; they're all small regardless of timeframe scope.
TIMEFRAME_KEYED_TABLES = (
    "candles",
    "swing_points",
    "bos_events",
    "fvg_events",
    "volume_imbalance_events",
    "liquidity_events",
)
FULL_COPY_TABLES = ("symbols", "order_blocks", "trades", "stats")

# Loud, not silent, if this regresses past the point of fitting the
# function-size budget again - re-derived from the platform-architect's
# own measurement (549.57MB observed / 499MB db => ~50MB of non-db bundle
# weight, so ~175MB is the real ceiling for this file with headroom).
MAX_DEPLOY_DB_BYTES = 175 * 1024 * 1024


def main() -> int:
    if not os.path.exists(SOURCE_DB_PATH):
        print(f"ERROR: {SOURCE_DB_PATH} does not exist - run build_db.py first.", file=sys.stderr)
        return 1

    if os.path.exists(DEPLOY_DB_PATH):
        os.remove(DEPLOY_DB_PATH)

    tf_list = ", ".join(f"'{tf}'" for tf in DEPLOY_TIMEFRAMES)
    con = duckdb.connect(SOURCE_DB_PATH, read_only=True)
    try:
        con.execute(f"ATTACH '{DEPLOY_DB_PATH}' AS deploy (READ_ONLY FALSE)")
        for table in TIMEFRAME_KEYED_TABLES:
            con.execute(f"CREATE TABLE deploy.{table} AS SELECT * FROM {table} WHERE timeframe IN ({tf_list})")
            count = con.execute(f"SELECT COUNT(*) FROM deploy.{table}").fetchone()[0]
            print(f"  {table}: {count} rows ({', '.join(DEPLOY_TIMEFRAMES)} only)")
        for table in FULL_COPY_TABLES:
            con.execute(f"CREATE TABLE deploy.{table} AS SELECT * FROM {table}")
            count = con.execute(f"SELECT COUNT(*) FROM deploy.{table}").fetchone()[0]
            print(f"  {table}: {count} rows (full copy)")
        con.execute("DETACH deploy")
    finally:
        con.close()

    size = os.path.getsize(DEPLOY_DB_PATH)
    print(f"\nWrote {DEPLOY_DB_PATH} ({size / 1e6:.1f} MB)")
    if size > MAX_DEPLOY_DB_BYTES:
        print(
            f"ERROR: {size / 1e6:.1f} MB exceeds the {MAX_DEPLOY_DB_BYTES / 1e6:.0f} MB safety budget for the "
            "deployed function - this would risk repeating the exact Vercel build failure this script exists to "
            "avoid. Investigate before shipping (more symbols/timeframes added since DEPLOY_TIMEFRAMES was chosen?).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
