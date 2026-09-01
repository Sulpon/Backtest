"""
Roadmap Phase 3, Task 3: stateless, synchronous, on-demand backtest
execution. No persistence, no DB schema, no frontend - see ROADMAP.md's
Phase 3 Decision 7 (Task 4 owns backtest_runs/backtest_run_trades; Task 5
owns the frontend).

This module owns:
  - the (symbol, timeframe) -> CSV catalog
  - the validated-combo rule (Decisions 2 and 5)
  - an input-size guard
  - run(), the only place BacktestConfig/run_backtest are imported from
    structure_engine - and only inside run()'s body, never at module level.

Why the import is lazy: structure_engine.py requires pandas/numpy, which are
requirements-dev.txt-only (Decision 4) - never requirements.txt, since
Vercel's function size limit is the reason for that split (see
docs/ARCHITECTURE.md's deployment section). app/main.py must stay importable
on a deployment that never installed pandas/numpy; only actually calling
run() (from inside the /api/backtest/run route handler) should need them,
and even then it should fail as a typed, catchable error (503 at the route),
not an ImportError crashing the whole app at import time.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
# This module lives at backend/app/backtest/ - two directories deeper than
# build_db.py (backend/), hence dirname() twice here, so the resulting
# DATA_DIR still lands on the repo root exactly like build_db.py's own
# HERE/DATA_DIR construction (build_db.py's HERE is backend/, DATA_DIR is
# backend/../..).
BACKEND_DIR = os.path.dirname(os.path.dirname(HERE))
DATA_DIR = os.path.join(BACKEND_DIR, "..", "..")

# Deliberately a second, independently-written literal, NOT an import of
# build_db.CSV_FILES - importing build_db here would work at runtime
# (pytest.ini's pythonpath=. would resolve it, and so would main.py's own
# sys.path) but would create a real coupling from a route module to a
# standalone offline script that this task's brief explicitly says must
# stay at zero diff. Instead, tests/test_backtest_routes.py imports
# build_db directly and asserts this dict is exactly equal to
# build_db.CSV_FILES, so drift between the two is a loud test failure
# rather than a silent divergence or an accidental shared-module coupling.
# Same broker-export "{SYMBOL}_{MT-STYLE-SUFFIX}.csv" convention build_db.py
# now uses for all 7 symbols - see that module's own CSV_FILES comment.
_SYMBOLS = ("EURUSD", "GBPUSD", "XAUUSD", "XAGUSD", "USDCAD", "USDCHF", "USDJPY")
_TF_SUFFIX = {"1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D1"}

CSV_FILES = {
    (symbol, tf): f"{symbol}_{suffix}.csv"
    for symbol in _SYMBOLS
    for tf, suffix in _TF_SUFFIX.items()
    # EURUSD "1d" intentionally absent - see build_db.py's module docstring.
    if (symbol, tf) != ("EURUSD", "1d")
}

# ROADMAP.md Phase 3 Decision 2: fib-OTE entry/SL/TP anchoring and A/B/C/D
# daily-bias tagging are validated ONLY for EURUSD 1h - the engine may run
# against any catalog entry, but every other combo's output must be labeled
# experimental, never presented as a checked backtest result. Decision 5:
# varying rr_ratio does not change this - the validated set is keyed on
# symbol/timeframe alone, never on which rr_ratio was used, so this is a
# plain set of (symbol, timeframe) pairs, not a function of the full config.
VALIDATED_COMBOS = {("EURUSD", "1h")}

# Threshold reasoning (measured against the actual repo root CSVs, all
# 1m/5m/15m/30m/1h/4h files currently in CSV_FILES, 2026-08-26): the largest
# is ~5.7MB (e.g. XAUUSD 5m/15m/30m/60m), the smallest intraday file ~1.4MB
# (the 4h combos), and the three "1d" files are all under 310KB. 20MB is
# roughly 3.5x the largest file actually on disk today - generous headroom
# for the CSVs simply growing with more history over time (this is a static,
# manually-refreshed export, not a live feed, so growth is slow) - while
# still bounding the worst case for run_backtest()'s pure-Python, ~O(bars)
# loop: a file many times larger than anything in the catalog today would
# mean tens of minutes of a blocked threadpool worker per request, which is
# exactly the failure mode this guard exists to reject up front, before
# ever invoking the engine.
MAX_CSV_BYTES = 20 * 1024 * 1024


class BacktestSymbolNotFound(Exception):
    """Raised when (symbol, timeframe) is not in CSV_FILES."""


class BacktestInputTooLarge(Exception):
    """Raised when the resolved CSV's on-disk size exceeds MAX_CSV_BYTES."""


class BacktestEngineUnavailable(Exception):
    """Raised when structure_engine.py's pandas/numpy dependency isn't
    installed in this deployment (ROADMAP.md Phase 3 Decisions 4 and 6)."""


def _resolve_csv_path(symbol: str, timeframe: str) -> str:
    key = (symbol, timeframe)
    if key not in CSV_FILES:
        raise BacktestSymbolNotFound(
            f"No backtest data catalogued for symbol={symbol!r} timeframe={timeframe!r}"
        )
    return os.path.join(DATA_DIR, CSV_FILES[key])


def validation_for(symbol: str, timeframe: str) -> dict:
    """(symbol, timeframe) -> {status, validated, message}. Independent of
    rr_ratio (Decision 5) - callers must not pass a config in here."""
    if (symbol, timeframe) in VALIDATED_COMBOS:
        return {
            "status": "validated",
            "validated": True,
            "message": (
                "EURUSD 1h is the one symbol/timeframe this engine's "
                "fib-OTE entry/SL/TP anchoring and A/B/C/D daily-bias "
                "tagging have been validated against; varying rr_ratio "
                "does not change this status (ROADMAP.md Phase 3 "
                "Decision 5)."
            ),
        }
    return {
        "status": "experimental",
        "validated": False,
        "message": (
            f"{symbol} {timeframe} runs through the same fib-OTE "
            "entry/SL/TP anchoring and A/B/C/D daily-bias tagging logic as "
            "EURUSD 1h, but that logic has only ever been validated against "
            "EURUSD 1h (ROADMAP.md Phase 3 Decision 2). Treat this result "
            "as an experimental, unchecked extension of the strategy, not a "
            "verified backtest."
        ),
    }


def run(symbol: str, timeframe: str, rr_ratio: float) -> dict:
    """Runs the one SMC/fib-OTE strategy synchronously against
    (symbol, timeframe) at the given rr_ratio and returns
    {"trades": [...], "stats": {...}} only - never bars/daily*/SMC-event
    arrays, which already have a home in /api/dataset (see this phase's
    task brief).

    Raises BacktestSymbolNotFound, BacktestInputTooLarge, or
    BacktestEngineUnavailable - callers (the FastAPI route) map each to a
    distinct HTTP status.
    """
    csv_path = _resolve_csv_path(symbol, timeframe)

    size = os.path.getsize(csv_path)
    if size > MAX_CSV_BYTES:
        raise BacktestInputTooLarge(
            f"{symbol} {timeframe} source CSV is {size} bytes, exceeding "
            f"the {MAX_CSV_BYTES}-byte on-demand execution guard"
        )

    # Deliberately inside the function body, not at module scope - see this
    # module's docstring. Any ImportError here (pandas/numpy missing) is
    # re-raised as a typed, route-catchable exception instead of propagating
    # as a raw ImportError.
    try:
        from ..structure_engine import BacktestConfig, run_backtest
    except ImportError as exc:
        raise BacktestEngineUnavailable(
            "backtest engine unavailable: this deployment does not have "
            "pandas/numpy installed (structure_engine.py requires them; "
            "they are requirements-dev.txt-only, never requirements.txt - "
            "see ROADMAP.md Phase 3 Decision 4)"
        ) from exc

    result = run_backtest(csv_path, BacktestConfig(rr_ratio=rr_ratio))
    return {"trades": result["trades"], "stats": result["stats"]}
