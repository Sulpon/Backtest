"""
CSV -> DuckDB, every symbol/timeframe combination currently available as a
local MT4-style export. Run this once (or whenever a CSV changes) to
(re)build data.duckdb. FastAPI only ever reads from the database this
produces - it never touches a CSV or runs an engine itself.

EURUSD's 1h/1d combo is the one exception: it goes through the full
run_backtest() pipeline (trade simulation, daily-bias A/B/C/D tagging,
order blocks, stats), reading ONLY EURUSD60 - run_backtest() derives its
own daily bars by resampling the 1H file internally, exactly as it always
has. This file deliberately does NOT also read EURUSD1440: doing so would
create two different sources of truth for the same (EURUSD, 1d) series,
and silently pick whichever happened to be inserted last. The EURUSD1440
file sits unused for that reason - not a bug, a preserved existing result.

Every other (symbol, timeframe) combination goes through compute_structure()
instead: real swings/BOS/CHoCH/FVG/volume-imbalance/liquidity, but no trade
simulation - see compute_structure()'s docstring for why.

Usage:
    .venv/Scripts/python.exe build_db.py
"""
import json
import os
from datetime import datetime, timezone

import duckdb

from app.structure_engine import compute_structure, run_backtest

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "..")
DB_PATH = os.path.join(HERE, "data.duckdb")

SYMBOL_LABELS = {
    "EURUSD": "EUR/USD",
    "GBPUSD": "GBP/USD",
    "XAUUSD": "XAU/USD (Gold)",
    "XAGUSD": "XAG/USD (Silver)",
    "USDCAD": "USD/CAD",
    "USDCHF": "USD/CHF",
    "USDJPY": "USD/JPY",
}

# (symbol, timeframe) -> csv filename, relative to the repo root. This is the
# broker-export naming convention the current source files actually use -
# "{SYMBOL}_{MT-STYLE-SUFFIX}.csv" - not worth renaming to make this table
# tidier. Supersedes an earlier "EURUSD1.csv"/"EURUSD60 (1).csv"-style
# convention previously used for EURUSD/GBPUSD/XAUUSD only, which is why
# every symbol below now uses one consistent scheme.
_TF_SUFFIX = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D1"}

CSV_FILES = {
    (symbol, tf): f"{symbol}_{suffix}.csv"
    for symbol in SYMBOL_LABELS
    for tf, suffix in _TF_SUFFIX.items()
    # EURUSD "1d" intentionally absent - see module docstring: run_backtest()
    # derives EURUSD's daily bars by resampling its own 1h input, so also
    # reading EURUSD_D1.csv would create a second, conflicting source of
    # truth for the same (EURUSD, 1d) series.
    if (symbol, tf) != ("EURUSD", "1d")
}

# Two conventions already existed in this codebase before this file grew to
# cover more than one symbol: intraday timeframes detect swings on closing
# price ("line source", run_backtest's USE_LINE_SOURCE=True for its 1H
# series), while "1d" uses actual high/low (run_backtest's daily-bias
# layer). Applying each convention to every timeframe of that same kind -
# instead of only to EURUSD's original two - is the only new decision here.
INTRADAY_SWING_LEN = 10  # same as run_backtest's 1H SWING_LEN
DAILY_SWING_LEN = 3  # same as run_backtest's DAILY_SWING_LEN

EURUSD_1H_1D_KEYS = {("EURUSD", "1h"), ("EURUSD", "1d")}


def to_unix(s: str) -> int:
    # Current exports include seconds ("...:00"); tolerate the older
    # seconds-less format too rather than assuming every source file agrees.
    fmt = "%Y-%m-%d %H:%M:%S" if s.count(":") == 2 else "%Y-%m-%d %H:%M"
    return int(datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp())


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    con = duckdb.connect(DB_PATH)

    con.execute("""
        CREATE TABLE candles (
            symbol VARCHAR, timeframe VARCHAR, bar_index INTEGER,
            time BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE
        )
    """)
    con.execute("""
        CREATE TABLE swing_points (
            symbol VARCHAR, timeframe VARCHAR,
            bar_index INTEGER, price DOUBLE, type VARCHAR, kind VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE bos_events (
            symbol VARCHAR, timeframe VARCHAR,
            bar_start INTEGER, bar_end INTEGER, price DOUBLE, direction VARCHAR, kind VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE fvg_events (
            symbol VARCHAR, timeframe VARCHAR,
            bar_index INTEGER, top DOUBLE, bottom DOUBLE, direction VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE order_blocks (
            symbol VARCHAR, bar_index INTEGER, bar_end INTEGER, top DOUBLE, bottom DOUBLE, direction VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE volume_imbalance_events (
            symbol VARCHAR, timeframe VARCHAR,
            bar_index INTEGER, top DOUBLE, bottom DOUBLE, direction VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE liquidity_events (
            symbol VARCHAR, timeframe VARCHAR,
            bar_start INTEGER, bar_end INTEGER, price DOUBLE, direction VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE trades (
            symbol VARCHAR, dir VARCHAR, entry_bar INTEGER, entry_price DOUBLE,
            sl DOUBLE, tp DOUBLE, exit_bar INTEGER, result VARCHAR, r DOUBLE, setup VARCHAR
        )
    """)
    con.execute("""
        CREATE TABLE stats (
            symbol VARCHAR PRIMARY KEY, total INTEGER, wins INTEGER, losses INTEGER,
            win_rate DOUBLE, expectancy DOUBLE, rr DOUBLE, breakeven_wr DOUBLE, by_setup JSON
        )
    """)
    con.execute("CREATE TABLE symbols (symbol VARCHAR PRIMARY KEY, label VARCHAR)")

    def insert_candles(symbol: str, timeframe: str, bars: list):
        rows = [(symbol, timeframe, i, to_unix(b[0]), b[1], b[2], b[3], b[4]) for i, b in enumerate(bars)]
        con.executemany(
            "INSERT INTO candles (symbol, timeframe, bar_index, time, open, high, low, close) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )

    def insert_swings(symbol: str, timeframe: str, swings: list):
        rows = [(symbol, timeframe, s[0], s[1], s[2], s[3]) for s in swings]
        con.executemany("INSERT INTO swing_points VALUES (?, ?, ?, ?, ?, ?)", rows)

    def insert_bos(symbol: str, timeframe: str, events: list):
        rows = [(symbol, timeframe, e[0], e[1], e[2], e[3], e[4]) for e in events]
        con.executemany("INSERT INTO bos_events VALUES (?, ?, ?, ?, ?, ?, ?)", rows)

    def insert_fvg(symbol: str, timeframe: str, events: list):
        rows = [(symbol, timeframe, e[0], e[1], e[2], e[3]) for e in events]
        con.executemany("INSERT INTO fvg_events VALUES (?, ?, ?, ?, ?, ?)", rows)

    def insert_volume_imbalance(symbol: str, timeframe: str, events: list):
        rows = [(symbol, timeframe, e[0], e[1], e[2], e[3]) for e in events]
        con.executemany("INSERT INTO volume_imbalance_events VALUES (?, ?, ?, ?, ?, ?)", rows)

    def insert_liquidity(symbol: str, timeframe: str, events: list):
        rows = [(symbol, timeframe, e[0], e[1], e[2], e[3]) for e in events]
        con.executemany("INSERT INTO liquidity_events VALUES (?, ?, ?, ?, ?, ?)", rows)

    # ---- EURUSD 1h/1d: full backtest pipeline (unchanged from before) ----
    eurusd_1h_csv = os.path.join(DATA_DIR, CSV_FILES[("EURUSD", "1h")])
    print(f"[EURUSD 1h+1d] running full backtest engine against {eurusd_1h_csv} ...")
    result = run_backtest(eurusd_1h_csv)
    print(
        f"  bars={len(result['bars'])} swings={len(result['swingPoints'])} "
        f"bos={len(result['bosEvents'])} fvg={len(result['fvgEvents'])} "
        f"orderBlocks={len(result['orderBlocks'])} trades={len(result['trades'])} "
        f"volumeImbalance={len(result['volumeImbalanceEvents'])} liquidity={len(result['liquidityEvents'])}"
    )

    insert_candles("EURUSD", "1h", result["bars"])
    insert_swings("EURUSD", "1h", result["swingPoints"])
    insert_bos("EURUSD", "1h", result["bosEvents"])
    insert_fvg("EURUSD", "1h", result["fvgEvents"])
    insert_volume_imbalance("EURUSD", "1h", result["volumeImbalanceEvents"])
    insert_liquidity("EURUSD", "1h", result["liquidityEvents"])
    insert_candles("EURUSD", "1d", result["dailyBars"])
    insert_swings("EURUSD", "1d", result["dailySwingPoints"])
    insert_bos("EURUSD", "1d", result["dailyBosEvents"])
    insert_fvg("EURUSD", "1d", result["dailyFvgEvents"])
    insert_volume_imbalance("EURUSD", "1d", result["dailyVolumeImbalanceEvents"])
    insert_liquidity("EURUSD", "1d", result["dailyLiquidityEvents"])

    ob_rows = [("EURUSD", o[0], o[1], o[2], o[3], o[4]) for o in result["orderBlocks"]]
    con.executemany("INSERT INTO order_blocks VALUES (?, ?, ?, ?, ?, ?)", ob_rows)

    trade_rows = [("EURUSD", t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]) for t in result["trades"]]
    con.executemany("INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", trade_rows)

    st = result["stats"]
    con.execute(
        "INSERT INTO stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["EURUSD", st["total"], st["wins"], st["losses"], st["winRate"], st["expectancy"],
         st["rr"], st["breakevenWr"], json.dumps(st["bySetup"])],
    )

    # ---- everything else: structure-only pass, no trades ----
    for (symbol, timeframe), filename in CSV_FILES.items():
        if (symbol, timeframe) in EURUSD_1H_1D_KEYS:
            continue
        csv_path = os.path.join(DATA_DIR, filename)
        swing_len = DAILY_SWING_LEN if timeframe == "1d" else INTRADAY_SWING_LEN
        use_line_source = timeframe != "1d"
        print(f"[{symbol} {timeframe}] computing structure from {filename} ...")
        s = compute_structure(csv_path, swing_len=swing_len, use_line_source=use_line_source)
        print(
            f"  bars={len(s['bars'])} swings={len(s['swingPoints'])} bos={len(s['bosEvents'])} "
            f"fvg={len(s['fvgEvents'])} volumeImbalance={len(s['volumeImbalanceEvents'])} "
            f"liquidity={len(s['liquidityEvents'])}"
        )
        insert_candles(symbol, timeframe, s["bars"])
        insert_swings(symbol, timeframe, s["swingPoints"])
        insert_bos(symbol, timeframe, s["bosEvents"])
        insert_fvg(symbol, timeframe, s["fvgEvents"])
        insert_volume_imbalance(symbol, timeframe, s["volumeImbalanceEvents"])
        insert_liquidity(symbol, timeframe, s["liquidityEvents"])

    for symbol, label in SYMBOL_LABELS.items():
        con.execute("INSERT INTO symbols VALUES (?, ?)", [symbol, label])

    con.execute("CREATE INDEX idx_candles ON candles (symbol, timeframe, bar_index)")
    con.execute("CREATE INDEX idx_swings ON swing_points (symbol, timeframe)")
    con.execute("CREATE INDEX idx_bos ON bos_events (symbol, timeframe)")
    con.execute("CREATE INDEX idx_fvg ON fvg_events (symbol, timeframe)")
    con.execute("CREATE INDEX idx_vi ON volume_imbalance_events (symbol, timeframe)")
    con.execute("CREATE INDEX idx_liq ON liquidity_events (symbol, timeframe)")
    con.execute("CREATE INDEX idx_ob ON order_blocks (symbol)")
    con.execute("CREATE INDEX idx_trades ON trades (symbol)")

    con.close()
    print(f"Wrote {DB_PATH}")


if __name__ == "__main__":
    main()
