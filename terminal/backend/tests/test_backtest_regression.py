"""
Regression baseline for the CURRENT, unmodified run_backtest()
(backend/app/structure_engine.py) against what's already shipped in
data.duckdb.

This exists so that any future Phase 3 generalization of run_backtest()
into a parameterized engine has a byte-for-byte-equivalent baseline to
diff against, per ROADMAP.md's Phase 3 verification criterion ("the
existing EURUSD 1h precomputed backtest's trades/stats are reproducible
byte-for-byte ... through the new general engine") and CLAUDE.md's hard
constraint that RR_RATIO/fib-OTE anchoring/daily-bias tagging never change
silently.

Like test_dataset_windowing.py, this runs against the real, checked-in
data.duckdb (read-only, via app.db.get_connection()) rather than a
synthetic fixture or a fresh build_db.py run - build_db.py destructively
`os.remove()`s data.duckdb before rebuilding it, which would discard any
Phase 2 market_candles/instruments/data_sync_jobs data sitting alongside
it (see docs/ARCHITECTURE.md's risk #5). Instead, this test calls
run_backtest() in-process against the exact same CSV path build_db.py
already used to populate the DB, and compares the two independently.

Three of run_backtest()'s 16 return keys (trades, stats, orderBlocks) have
a directly diffable DB representation and are compared field-by-field
below. The remaining 13 (bars, swingPoints, bosEvents, fibLegs, fvgEvents,
volumeImbalanceEvents, liquidityEvents, and their daily* counterparts)
either aren't stored in the DB in a directly comparable shape for this
purpose or are intentionally cross-checked against a committed golden
hash manifest instead (tests/fixtures/eurusd_1h_backtest_golden.json),
generated once from this same unmodified engine - so this test is, by
construction, the correct pre-refactor baseline.
"""
import hashlib
import json
import os
import time

import pytest

from app.db import get_connection
from app.structure_engine import run_backtest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(TESTS_DIR)
# Mirrors build_db.py's own HERE + DATA_DIR construction exactly (see
# build_db.py: HERE = dirname(build_db.py), DATA_DIR = HERE/../..) - this
# test lives one directory deeper (tests/), hence BACKEND_DIR here instead
# of TESTS_DIR, so the resulting DATA_DIR still lands on the repo root.
DATA_DIR = os.path.join(BACKEND_DIR, "..", "..")
CSV_PATH = os.path.join(DATA_DIR, "EURUSD60 (1).csv")

GOLDEN_MANIFEST_PATH = os.path.join(TESTS_DIR, "fixtures", "eurusd_1h_backtest_golden.json")

# Keys directly diffable against a DB table/row; every other key in
# run_backtest()'s return dict is compared via the golden hash manifest.
DB_DIFFABLE_KEYS = {"trades", "stats", "orderBlocks"}


def _hash_value(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@pytest.fixture(scope="module")
def backtest_result():
    """run_backtest() pushes ~100,000 bars through pure-Python loops
    (~2s/call - see test_run_backtest_runtime_is_reported for the measured
    number). Module-scoped so the five assertion tests below that all need
    a full result share one call instead of five, keeping this file's
    contribution to the full suite's runtime close to a single run rather
    than N runs. This is a shared fixture, not a shortcut around any
    individual test's own assertions - every test below still independently
    checks its own slice of the same, single, real run_backtest() output."""
    return run_backtest(CSV_PATH)


def test_csv_path_matches_build_db_pys_eurusd_1h_source():
    """Sanity check on the path-construction logic itself, so a future
    change to build_db.py's directory layout fails loudly here instead of
    this test silently reading the wrong (or a nonexistent) file."""
    assert os.path.basename(CSV_PATH) == "EURUSD60 (1).csv"
    assert os.path.exists(CSV_PATH), f"expected EURUSD 1h source CSV at {CSV_PATH}"


def test_run_backtest_trades_match_data_duckdb_byte_for_byte(backtest_result):
    result = backtest_result

    con = get_connection()
    rows = con.execute(
        "SELECT dir, entry_bar, entry_price, sl, tp, exit_bar, result, r, setup "
        "FROM trades WHERE symbol='EURUSD' ORDER BY entry_bar"
    ).fetchall()

    engine_trades = result["trades"]

    assert len(engine_trades) == len(rows), (
        f"trade count mismatch: engine produced {len(engine_trades)}, "
        f"data.duckdb has {len(rows)}"
    )

    columns = ["dir", "entry_bar", "entry_price", "sl", "tp", "exit_bar", "result", "r", "setup"]
    for i, (engine_row, db_row) in enumerate(zip(engine_trades, rows)):
        for col_name, engine_val, db_val in zip(columns, engine_row, db_row):
            assert engine_val == db_val, (
                f"trade #{i} (entry_bar={engine_row[1]}) field '{col_name}' mismatch: "
                f"engine={engine_val!r} db={db_val!r}"
            )


def test_run_backtest_stats_match_data_duckdb_byte_for_byte(backtest_result):
    result = backtest_result
    stats = result["stats"]

    con = get_connection()
    row = con.execute(
        "SELECT total, wins, losses, win_rate, expectancy, rr, breakeven_wr, by_setup "
        "FROM stats WHERE symbol='EURUSD'"
    ).fetchone()
    assert row is not None, "no stats row for symbol='EURUSD' in data.duckdb"

    db_total, db_wins, db_losses, db_win_rate, db_expectancy, db_rr, db_breakeven_wr, db_by_setup_json = row
    db_by_setup = json.loads(db_by_setup_json)

    assert stats["total"] == db_total
    assert stats["wins"] == db_wins
    assert stats["losses"] == db_losses
    assert stats["winRate"] == db_win_rate
    assert stats["expectancy"] == db_expectancy
    assert stats["rr"] == db_rr
    assert stats["breakevenWr"] == db_breakeven_wr
    assert stats["bySetup"] == db_by_setup


def test_run_backtest_order_blocks_match_data_duckdb_byte_for_byte(backtest_result):
    """Unlike trades (naturally chronological - one open position at a time),
    order_blocks is NOT emitted in bar_index order: structure_engine.py
    derives it 1:1 from fib_legs, which append in impulse-CONFIRMATION order
    (effectively bar_end/loop-iteration order), not anchor bar_start order -
    verified directly against the code, not assumed. Relying on either
    side's incidental order (the engine list's own order, or an unordered
    SELECT's incidental physical scan order) is exactly the fragile
    assumption a byte-for-byte regression baseline must not make - so both
    sides are sorted by the same canonical key before comparing, making this
    an order-independent content comparison rather than a sequence
    comparison."""
    result = backtest_result
    engine_obs = sorted(result["orderBlocks"], key=tuple)

    con = get_connection()
    rows = con.execute(
        "SELECT bar_index, bar_end, top, bottom, direction FROM order_blocks "
        "WHERE symbol='EURUSD' ORDER BY bar_index, bar_end, top, bottom, direction"
    ).fetchall()

    assert len(engine_obs) == len(rows), (
        f"order block count mismatch: engine produced {len(engine_obs)}, "
        f"data.duckdb has {len(rows)}"
    )

    columns = ["bar_index", "bar_end", "top", "bottom", "direction"]
    for i, (engine_row, db_row) in enumerate(zip(engine_obs, rows)):
        for col_name, engine_val, db_val in zip(columns, engine_row, db_row):
            assert engine_val == db_val, (
                f"order block #{i} (sorted position, not emission order) field "
                f"'{col_name}' mismatch: "
                f"engine={engine_val!r} db={db_val!r}"
            )


def test_run_backtest_remaining_keys_match_golden_hash_manifest(backtest_result):
    """Every run_backtest() return key that isn't directly diffable against
    a DB table (bars, swingPoints, bosEvents, fibLegs, fvgEvents,
    volumeImbalanceEvents, liquidityEvents, and the daily* counterparts of
    those) is compared here via a SHA-256 hash of its
    json.dumps(value, sort_keys=True, separators=(",", ":")) form, against
    the golden manifest committed alongside this test."""
    result = backtest_result

    with open(GOLDEN_MANIFEST_PATH) as f:
        golden = json.load(f)

    remaining_keys = sorted(set(result.keys()) - DB_DIFFABLE_KEYS)
    assert remaining_keys == sorted(golden.keys()), (
        "run_backtest()'s non-DB-diffable key set no longer matches the golden "
        "manifest's key set - this itself is a change to the return shape, not "
        "just a value, and needs its own explicit review before regenerating "
        "the manifest."
    )

    for key in remaining_keys:
        actual_hash = _hash_value(result[key])
        assert actual_hash == golden[key], (
            f"run_backtest()['{key}'] no longer matches the golden hash - "
            f"this is a trading-logic/output change and must not be silently "
            f"accepted (see CLAUDE.md's hard constraints on RR_RATIO/fib-OTE "
            f"anchoring/daily-bias tagging)."
        )


def test_run_backtest_full_return_dict_has_exactly_16_keys(backtest_result):
    """Pins the authoritative key count/list this test suite was built
    against, so a future addition/removal of a return key is caught here
    explicitly rather than only showing up as a silent gap in coverage."""
    result = backtest_result
    expected_keys = {
        "bars", "swingPoints", "bosEvents", "fibLegs", "fvgEvents", "orderBlocks",
        "volumeImbalanceEvents", "liquidityEvents", "dailyBars", "dailySwingPoints",
        "dailyBosEvents", "dailyFvgEvents", "dailyVolumeImbalanceEvents",
        "dailyLiquidityEvents", "trades", "stats",
    }
    assert set(result.keys()) == expected_keys
    assert len(expected_keys) == 16


def test_run_backtest_runtime_is_reported():
    """Not a correctness assertion - measures and reports run_backtest()'s
    wall-clock runtime (it runs ~100,000 bars through pure-Python loops),
    so a future engine-generalization change's performance impact is
    visible rather than assumed. Intentionally has no upper-bound assert:
    slowness alone is not a regression this test is meant to police."""
    t0 = time.perf_counter()
    run_backtest(CSV_PATH)
    elapsed = time.perf_counter() - t0
    print(f"\nrun_backtest(EURUSD 1h) wall-clock: {elapsed:.3f}s")
