"""
export_deploy_db.py's output, verified against the real checked-in
data.duckdb - like test_dataset_windowing.py, this deliberately runs
against the real files (not a synthetic fixture) because the whole point
is proving the deployed artifact is a correct, complete derivation of
production's actual data, not a stand-in for it. See export_deploy_db.py's
own docstring for why this artifact exists at all (Vercel's 225MB function
bundle limit).
"""
import os

import duckdb
import pytest

from export_deploy_db import DEPLOY_TIMEFRAMES, FULL_COPY_TABLES, MAX_DEPLOY_DB_BYTES, TIMEFRAME_KEYED_TABLES
from app.db import DB_PATH as SOURCE_DB_PATH

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(HERE)
DEPLOY_DB_PATH = os.path.join(BACKEND_DIR, "data.deploy.duckdb")


@pytest.fixture(scope="module")
def source_con():
    # SOURCE_DB_PATH is app.db.DB_PATH, which is itself VERCEL-env-
    # dependent (see app/db.py) - tests never set VERCEL, so this is
    # always the full local data.duckdb, exactly what export_deploy_db.py
    # itself reads from.
    con = duckdb.connect(SOURCE_DB_PATH, read_only=True)
    yield con
    con.close()


@pytest.fixture(scope="module")
def deploy_con():
    if not os.path.exists(DEPLOY_DB_PATH):
        pytest.skip(f"{DEPLOY_DB_PATH} doesn't exist - run export_deploy_db.py first")
    con = duckdb.connect(DEPLOY_DB_PATH, read_only=True)
    yield con
    con.close()


def test_deploy_db_stays_under_the_function_size_budget():
    assert os.path.exists(DEPLOY_DB_PATH), "run export_deploy_db.py before this test"
    size = os.path.getsize(DEPLOY_DB_PATH)
    assert size <= MAX_DEPLOY_DB_BYTES, (
        f"data.deploy.duckdb is {size / 1e6:.1f} MB, over the {MAX_DEPLOY_DB_BYTES / 1e6:.0f} MB safety budget - "
        "this is exactly the Vercel function-size failure this artifact exists to prevent."
    )


def test_deploy_db_has_no_indexes(deploy_con):
    assert deploy_con.execute("SELECT * FROM duckdb_indexes()").fetchall() == []


@pytest.mark.parametrize("table", TIMEFRAME_KEYED_TABLES)
def test_timeframe_keyed_tables_only_contain_deploy_timeframes(deploy_con, table):
    rows = deploy_con.execute(f"SELECT DISTINCT timeframe FROM {table}").fetchall()
    seen = {r[0] for r in rows}
    assert seen <= set(DEPLOY_TIMEFRAMES), f"{table} has timeframes outside {DEPLOY_TIMEFRAMES}: {seen - set(DEPLOY_TIMEFRAMES)}"


@pytest.mark.parametrize("table", TIMEFRAME_KEYED_TABLES)
def test_timeframe_keyed_tables_match_source_row_counts_exactly(source_con, deploy_con, table):
    tf_list = ", ".join(f"'{tf}'" for tf in DEPLOY_TIMEFRAMES)
    expected = source_con.execute(f"SELECT COUNT(*) FROM {table} WHERE timeframe IN ({tf_list})").fetchone()[0]
    actual = deploy_con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    assert actual == expected


@pytest.mark.parametrize("table", FULL_COPY_TABLES)
def test_full_copy_tables_match_source_row_counts_exactly(source_con, deploy_con, table):
    expected = source_con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    actual = deploy_con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    assert actual == expected


def test_every_source_symbol_is_present_in_the_deploy_db(source_con, deploy_con):
    source_symbols = {r[0] for r in source_con.execute("SELECT symbol FROM symbols").fetchall()}
    deploy_symbols = {r[0] for r in deploy_con.execute("SELECT symbol FROM symbols").fetchall()}
    assert deploy_symbols == source_symbols


def test_eurusd_1h_candles_are_byte_identical_to_source(source_con, deploy_con):
    """Spot check on the one symbol/timeframe combo real users actually
    depend on today (the validated EURUSD 1h backtest) - not just row
    counts, but the actual OHLC values, to prove this is a lossless
    filter, not a re-derivation that could silently diverge."""
    query = "SELECT bar_index, time, open, high, low, close FROM candles WHERE symbol='EURUSD' AND timeframe='1h' ORDER BY bar_index"
    assert deploy_con.execute(query).fetchall() == source_con.execute(query).fetchall()


def test_deploy_db_excludes_1m_5m_15m_30m_entirely(deploy_con):
    remaining = deploy_con.execute(
        "SELECT DISTINCT timeframe FROM candles WHERE timeframe NOT IN ('1h', '4h', '1d')"
    ).fetchall()
    assert remaining == []
