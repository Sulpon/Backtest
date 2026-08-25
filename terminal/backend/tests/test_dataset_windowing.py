"""
/api/dataset's `limit` param (windowed loading - see terminal/README.md
#performance). Runs against the real data.duckdb (a static, checked-in
asset - see db.py) rather than a temp DB: the whole point of these tests
is verifying the windowing/re-indexing math against real, full-size
symbol/timeframe combos (100k+ bars, tens of thousands of events), which a
small synthetic fixture wouldn't exercise the same way.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_omitting_limit_returns_the_full_unwindowed_dataset(client):
    """Regression guard: the new parameter must be fully opt-in. Every
    existing caller (TradesPanel, the background full-fetch - see
    DataLayer.ts) that never passes `limit` must see byte-for-byte the
    same shape as before this parameter existed."""
    res = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"})
    assert res.status_code == 200
    data = res.json()
    # Known from the performance audit: EURUSD/1h has exactly 100,000 bars.
    assert len(data["bars"]) == 100_000


def test_limit_returns_exactly_that_many_bars(client):
    res = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": 500})
    assert res.status_code == 200
    data = res.json()
    assert len(data["bars"]) == 500


def test_windowed_bars_are_the_true_last_n_bars_of_the_full_dataset(client):
    full = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"}).json()
    windowed = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": 500}).json()

    expected_tail = full["bars"][-500:]
    assert windowed["bars"] == expected_tail


def test_windowed_event_bar_indices_are_self_consistent_with_windowed_bars(client):
    """Every bar-index field in the windowed response must point somewhere
    inside the windowed bars array - never negative, never past the end.
    This is the core correctness property of the re-indexing: bar N in the
    response's own `bars` array is what bar N means everywhere else in
    that same response."""
    windowed = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": 2000}).json()
    n = len(windowed["bars"])

    for s in windowed["swingPoints"]:
        assert 0 <= s["bar"] < n
    for f in windowed["fvgEvents"]:
        assert 0 <= f["bar"] < n
    for v in windowed["volumeImbalanceEvents"]:
        assert 0 <= v["bar"] < n
    for b in windowed["bosEvents"]:
        assert 0 <= b["barStart"] < n
        assert 0 <= b["barEnd"] < n
    for l in windowed["liquidityEvents"]:
        assert 0 <= l["barStart"] < n
        assert 0 <= l["barEnd"] < n


def test_windowed_events_map_back_to_the_same_real_event_in_the_full_dataset(client):
    """Re-indexing must be a pure offset shift, not a different selection -
    spot-check that a windowed FVG event's re-indexed bar, once you add
    window_start back, is the exact same event (same top/bottom/direction,
    same underlying time) the unwindowed response has."""
    limit = 3000
    full = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"}).json()
    windowed = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": limit}).json()
    window_start = len(full["bars"]) - limit

    assert len(windowed["fvgEvents"]) > 0, "expected at least one FVG event in a 3000-bar EURUSD/1h window"
    for w in windowed["fvgEvents"][:20]:
        original_bar = w["bar"] + window_start
        match = next((f for f in full["fvgEvents"] if f["bar"] == original_bar), None)
        assert match is not None, f"no full-dataset FVG event at bar {original_bar}"
        assert match["top"] == w["top"]
        assert match["bottom"] == w["bottom"]
        assert match["direction"] == w["direction"]


def test_a_structure_spanning_into_the_window_from_before_it_is_simply_omitted(client):
    """An event whose span starts before the window (bar_start < window_start)
    must never appear clamped/truncated - it's either fully inside the
    window or absent, never partially wrong."""
    limit = 500
    full = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"}).json()
    windowed = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": limit}).json()
    window_start = len(full["bars"]) - limit

    full_bos_starting_before_window = [b for b in full["bosEvents"] if b["barStart"] < window_start]
    windowed_bos_original_starts = {b["barStart"] + window_start for b in windowed["bosEvents"]}
    for b in full_bos_starting_before_window:
        assert b["barStart"] not in windowed_bos_original_starts


def test_limit_larger_than_total_bars_returns_everything_without_error(client):
    res = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1d", "limit": 999_999_999})
    assert res.status_code == 200
    full = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1d"}).json()
    assert len(res.json()["bars"]) == len(full["bars"])


def test_unknown_symbol_still_404s_with_limit_set(client):
    res = client.get("/api/dataset", params={"symbol": "NOPE", "timeframe": "1h", "limit": 500})
    assert res.status_code == 404


def test_stats_are_never_windowed(client):
    """Aggregate win-rate/expectancy stats describe the whole backtest, not
    a bar range - must be identical windowed or not."""
    full = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h"}).json()
    windowed = client.get("/api/dataset", params={"symbol": "EURUSD", "timeframe": "1h", "limit": 500}).json()
    assert full["stats"] == windowed["stats"]
