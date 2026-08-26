"""
POST /api/backtest/run - Roadmap Phase 3 Task 3's stateless, synchronous,
on-demand backtest execution route. Covers:

  - EURUSD 1h at default rr_ratio and at an explicit non-default rr_ratio,
    each cross-checked against run_backtest() called directly (same
    CSV-path-construction pattern as test_backtest_regression.py) - both
    must report validation.status == "validated" per Decision 5 (parameter
    variation never changes the validated/experimental label).
  - A non-EURUSD-1h combo present in the catalog -> experimental.
  - An unknown (symbol, timeframe) -> 404.
  - The catalog itself never silently drifts from build_db.py's CSV_FILES -
    imports build_db directly (works via pytest.ini's pythonpath=.) rather
    than assuming the two literals were kept in sync by hand.
  - The non-blocking concurrency guard (429 while a run is already holding
    the module-level lock).
  - build_db.py stays at zero diff - this task calls the engine, it does not
    touch the offline build script.

Deliberately does NOT test /api/dataset or any existing route - this file's
job is the new route only.
"""
import os
import subprocess

import pytest
from fastapi.testclient import TestClient

import build_db
from app import main
from app.backtest import runner
from app.structure_engine import BacktestConfig, run_backtest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.join(BACKEND_DIR, "..", "..")

EURUSD_1H_CSV = os.path.join(REPO_ROOT, "EURUSD60 (1).csv")


@pytest.fixture
def client():
    return TestClient(main.app)


def _trade_tuple(trade_model: dict) -> tuple:
    """Response Trade -> the same 9-tuple shape run_backtest() emits, so it
    can be compared directly against the engine's own trade rows."""
    return (
        trade_model["dir"], trade_model["entryBar"], trade_model["entryPrice"],
        trade_model["sl"], trade_model["tp"], trade_model["exitBar"],
        trade_model["result"], trade_model["r"], trade_model["setup"],
    )


def test_eurusd_1h_default_rr_ratio_matches_run_backtest_directly(client):
    expected = run_backtest(EURUSD_1H_CSV)

    res = client.post("/api/backtest/run", json={"symbol": "EURUSD", "timeframe": "1h"})

    assert res.status_code == 200
    body = res.json()

    assert body["symbol"] == "EURUSD"
    assert body["timeframe"] == "1h"
    assert body["strategy"] == "smc_fib_ote"
    assert body["config"] == {"rrRatio": 2.45}
    assert body["validation"]["status"] == "validated"
    assert body["validation"]["validated"] is True
    assert body["validation"]["message"]

    assert [_trade_tuple(t) for t in body["trades"]] == [tuple(t) for t in expected["trades"]]

    expected_stats = expected["stats"]
    assert body["stats"]["total"] == expected_stats["total"]
    assert body["stats"]["wins"] == expected_stats["wins"]
    assert body["stats"]["losses"] == expected_stats["losses"]
    assert body["stats"]["winRate"] == expected_stats["winRate"]
    assert body["stats"]["expectancy"] == expected_stats["expectancy"]
    assert body["stats"]["rr"] == expected_stats["rr"]
    assert body["stats"]["breakevenWr"] == expected_stats["breakevenWr"]
    assert body["stats"]["bySetup"] == expected_stats["bySetup"]

    # The response must never carry bars/daily*/SMC-event arrays - those
    # already have a home in /api/dataset.
    assert set(body.keys()) == {"symbol", "timeframe", "strategy", "config", "validation", "trades", "stats"}


def test_eurusd_1h_alt_rr_ratio_matches_run_backtest_directly_and_stays_validated(client):
    alt_rr = 1.5
    expected = run_backtest(EURUSD_1H_CSV, BacktestConfig(rr_ratio=alt_rr))

    res = client.post("/api/backtest/run", json={"symbol": "EURUSD", "timeframe": "1h", "rr_ratio": alt_rr})

    assert res.status_code == 200
    body = res.json()

    assert body["config"] == {"rrRatio": alt_rr}
    # Decision 5: varying rr_ratio does not change the validated label.
    assert body["validation"]["status"] == "validated"
    assert body["validation"]["validated"] is True

    assert [_trade_tuple(t) for t in body["trades"]] == [tuple(t) for t in expected["trades"]]
    assert body["stats"]["rr"] == alt_rr == expected["stats"]["rr"]
    assert body["stats"]["breakevenWr"] == expected["stats"]["breakevenWr"]


def test_non_eurusd_1h_combo_is_experimental(client):
    # GBPUSD 1h is present in build_db.CSV_FILES but is not the validated
    # combo (Decision 2) - pick it explicitly rather than assuming.
    assert ("GBPUSD", "1h") in build_db.CSV_FILES

    res = client.post("/api/backtest/run", json={"symbol": "GBPUSD", "timeframe": "1h"})

    assert res.status_code == 200
    body = res.json()

    assert body["validation"]["status"] == "experimental"
    assert body["validation"]["validated"] is False
    message = body["validation"]["message"]
    assert isinstance(message, str) and len(message) > 20
    assert "GBPUSD" in message and "1h" in message
    assert "EURUSD" in message  # explains what IS validated, not a placeholder


def test_non_positive_rr_ratio_is_rejected_with_422_not_500(client):
    """structure_engine.py's breakevenWr = 100 / (1 + RR_RATIO) divides by
    zero at rr_ratio=-1 and produces nonsensical output for any rr_ratio
    <= 0 - the request boundary must reject these cleanly rather than
    letting them reach the engine and surface as an opaque 502."""
    for bad_ratio in (0, -1.0, -5.0):
        res = client.post("/api/backtest/run", json={"symbol": "EURUSD", "timeframe": "1h", "rr_ratio": bad_ratio})
        assert res.status_code == 422, f"rr_ratio={bad_ratio} should be rejected at the request boundary"


def test_unknown_symbol_timeframe_combo_returns_404(client):
    res = client.post("/api/backtest/run", json={"symbol": "NOPE", "timeframe": "1h"})
    assert res.status_code == 404

    res2 = client.post("/api/backtest/run", json={"symbol": "EURUSD", "timeframe": "1d"})
    assert res2.status_code == 404


def test_catalog_matches_build_db_csv_files_exactly():
    """The single guarantee this task's brief requires in place of a shared
    module: runner.CSV_FILES and build_db.CSV_FILES are two independently
    written literals that must never silently drift."""
    assert runner.CSV_FILES == build_db.CSV_FILES


def test_validated_combos_is_exactly_eurusd_1h():
    assert runner.VALIDATED_COMBOS == {("EURUSD", "1h")}


def test_concurrent_request_returns_429_when_lock_already_held(client):
    acquired = main._backtest_run_lock.acquire(blocking=False)
    assert acquired, "test setup expected to acquire the lock itself"
    try:
        res = client.post("/api/backtest/run", json={"symbol": "EURUSD", "timeframe": "1h"})
        assert res.status_code == 429
        assert "already in progress" in res.json()["detail"]
    finally:
        main._backtest_run_lock.release()


def test_build_db_py_has_zero_diff():
    """This task calls the engine on demand; it must never modify the
    offline build script itself."""
    result = subprocess.run(
        ["git", "diff", "--stat", "--", "terminal/backend/build_db.py"],
        cwd=os.path.join(REPO_ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "", f"build_db.py has unexpected diff:\n{result.stdout}"
