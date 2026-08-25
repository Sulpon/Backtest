"""
Proves BacktestConfig.rr_ratio actually has an effect on run_backtest()'s
output - the complement of test_backtest_regression.py, which proves the
*default* config is byte-identical to the pre-Phase-3 engine. Together they
satisfy ROADMAP.md's Phase 3 verification criterion: "the engine can run ...
with a configurable parameter (e.g. RR_RATIO) and produce a distinct,
sensible result."

Per ROADMAP.md's Phase 3 Decision 1, only rr_ratio is parameterized in this
task - this test exercises exactly that one field, nothing else.
"""
import os

from app.structure_engine import BacktestConfig, run_backtest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(TESTS_DIR)
DATA_DIR = os.path.join(BACKEND_DIR, "..", "..")
CSV_PATH = os.path.join(DATA_DIR, "EURUSD60 (1).csv")

ALT_RR_RATIO = 1.5


def test_alt_rr_ratio_produces_distinct_and_sensible_result():
    default_result = run_backtest(CSV_PATH)
    alt_result = run_backtest(CSV_PATH, BacktestConfig(rr_ratio=ALT_RR_RATIO))

    default_stats = default_result["stats"]
    alt_stats = alt_result["stats"]

    # The config value round-trips into stats["rr"] and, since breakevenWr is
    # derived directly from it (100 / (1 + rr)), that changes too - a lower
    # RR ratio has a *lower* required breakeven win rate.
    assert default_stats["rr"] == 2.45
    assert alt_stats["rr"] == ALT_RR_RATIO
    assert alt_stats["rr"] != default_stats["rr"]
    assert alt_stats["breakevenWr"] == round(100 / (1 + ALT_RR_RATIO), 2)
    assert alt_stats["breakevenWr"] != default_stats["breakevenWr"]

    # Trade count (entry/SL/setup logic is untouched by rr_ratio) must be
    # identical - only exit-side fields (TP price, R multiple on a win, and
    # potentially which exit is hit first) may differ.
    assert len(default_result["trades"]) == len(alt_result["trades"])
    assert default_stats["total"] == alt_stats["total"]

    # A lower RR_RATIO means a closer take-profit, so at least one trade's
    # TP price must differ, and the overall trade list must not be identical.
    assert default_result["trades"] != alt_result["trades"]

    tp_col, r_col = 4, 7
    tp_differs = any(
        d[tp_col] != a[tp_col] for d, a in zip(default_result["trades"], alt_result["trades"])
    )
    assert tp_differs, "expected at least one trade's TP to move with rr_ratio"

    # Every winning trade's recorded R must equal the configured rr_ratio
    # (never the default 2.45) in the alt run - this is the direct causal
    # link between the config field and per-trade output, not just an
    # aggregate stat.
    alt_win_rs = {t[r_col] for t in alt_result["trades"] if t[6] == "Win"}
    assert alt_win_rs == {ALT_RR_RATIO}

    default_win_rs = {t[r_col] for t in default_result["trades"] if t[6] == "Win"}
    assert default_win_rs == {2.45}

    # Win rate is expected to differ too (closer TP is easier to hit before
    # SL), though this assertion is secondary evidence - the TP/R checks
    # above are the primary, directly-explainable proof.
    assert alt_stats["winRate"] != default_stats["winRate"]
