"""
data_ingestion/ - Dukascopy historical-data ingestion pipeline. No test
here ever touches the real, checked-in data.duckdb, and no test here ever
makes a real network call to datafeed.dukascopy.com - fetcher tests use
httpx.MockTransport (mirroring this repo's existing "inject an
httpx.Client" convention from app/marketdata/providers/oanda.py), and
DuckDB tests build a private, minimal candles/symbols schema in a
tmp_path-based temp file (mirroring test_rw_ro_coexistence.py's own
shutil.copy2-into-tmp_path pattern, adapted here to a from-scratch schema
since these tests don't need the full real dataset, just the two tables
data_ingestion/importer.py actually touches).
"""
from __future__ import annotations

import lzma
import struct
from datetime import datetime, timezone

import duckdb
import httpx
import pytest

from app.marketdata.models import Candle, PriceKind
from app.marketdata.timeframes import aggregate_candles

from data_ingestion import cache as cache_module
from data_ingestion.aggregator import aggregate_to_timeframes, ticks_to_1m_candles
from data_ingestion.fetcher import RawTick, build_url, decompress_bi5, fetch_raw_hour, parse_ticks
from data_ingestion.importer import (
    ensure_schema_migration,
    ensure_symbol_registered,
    get_coverage,
    upsert_symbol_timeframe,
)
from data_ingestion.orchestrator import compute_fetch_ranges, reaggregate_higher_timeframes, run_ingestion
from data_ingestion.symbols_point_values import point_value


# ---------------------------------------------------------------------------
# fetcher.py: build_url
# ---------------------------------------------------------------------------


def test_build_url_january_is_zero_indexed():
    url = build_url("EURUSD", datetime(2026, 1, 15, 3, tzinfo=timezone.utc))
    assert url == "https://datafeed.dukascopy.com/datafeed/EURUSD/2026/00/15/03h_ticks.bi5"


def test_build_url_december_is_eleven():
    url = build_url("EURUSD", datetime(2026, 12, 31, 23, tzinfo=timezone.utc))
    assert url == "https://datafeed.dukascopy.com/datafeed/EURUSD/2026/11/31/23h_ticks.bi5"


# ---------------------------------------------------------------------------
# fetcher.py: decompress_bi5
# ---------------------------------------------------------------------------


def test_decompress_bi5_roundtrip():
    original = b"some raw tick bytes"
    compressed = lzma.compress(original)
    assert decompress_bi5(compressed) == original


def test_decompress_bi5_empty_input_returns_empty_output():
    assert decompress_bi5(b"") == b""


# ---------------------------------------------------------------------------
# fetcher.py: parse_ticks
# ---------------------------------------------------------------------------


def _pack_tick(ms_offset: int, raw_ask: int, raw_bid: int, ask_vol: float, bid_vol: float) -> bytes:
    return struct.pack(">iiiff", ms_offset, raw_ask, raw_bid, ask_vol, bid_vol)


def test_parse_ticks_standard_pair_point_value():
    hour_start = int(datetime(2026, 8, 24, 10, tzinfo=timezone.utc).timestamp())
    payload = _pack_tick(1500, 110050, 110040, 1.5, 2.0) + _pack_tick(2500, 110060, 110045, 1.0, 1.0)
    ticks = parse_ticks(payload, "EURUSD", hour_start)
    assert len(ticks) == 2
    assert ticks[0] == RawTick(timestamp_utc=hour_start + 1, ask=1.1005, bid=1.1004, ask_volume=1.5, bid_volume=2.0)
    assert ticks[1] == RawTick(timestamp_utc=hour_start + 2, ask=1.1006, bid=1.10045, ask_volume=1.0, bid_volume=1.0)


def test_parse_ticks_jpy_point_value():
    hour_start = int(datetime(2026, 8, 24, 10, tzinfo=timezone.utc).timestamp())
    payload = _pack_tick(0, 149500, 149480, 1.0, 1.0)
    ticks = parse_ticks(payload, "USDJPY", hour_start)
    assert ticks[0].ask == pytest.approx(149.5)
    assert ticks[0].bid == pytest.approx(149.48)


def test_parse_ticks_empty_payload_returns_empty_list():
    assert parse_ticks(b"", "EURUSD", 0) == []


# ---------------------------------------------------------------------------
# fetcher.py: fetch_raw_hour (httpx.MockTransport - no real network)
# ---------------------------------------------------------------------------


def test_fetch_raw_hour_cache_hit_never_calls_transport(tmp_path):
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["count"] += 1
        return httpx.Response(200, content=b"should not be reached")

    cache_dir = str(tmp_path)
    dt = datetime(2026, 8, 24, 10, tzinfo=timezone.utc)
    path = cache_module.cache_path("EURUSD", dt, cache_dir)
    cache_module.write_cache(path, b"cached-bytes")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = fetch_raw_hour("EURUSD", dt, client=client, cache_dir=cache_dir)

    assert result == b"cached-bytes"
    assert called["count"] == 0


def test_fetch_raw_hour_successful_fetch_writes_cache(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"fresh-bytes")

    cache_dir = str(tmp_path)
    dt = datetime(2026, 8, 24, 10, tzinfo=timezone.utc)
    client = httpx.Client(transport=httpx.MockTransport(handler))

    result = fetch_raw_hour("EURUSD", dt, client=client, cache_dir=cache_dir)

    assert result == b"fresh-bytes"
    path = cache_module.cache_path("EURUSD", dt, cache_dir)
    assert cache_module.read_cached(path) == b"fresh-bytes"


def test_fetch_raw_hour_404_is_cached_as_empty_not_an_error(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    cache_dir = str(tmp_path)
    dt = datetime(2026, 8, 24, 10, tzinfo=timezone.utc)
    client = httpx.Client(transport=httpx.MockTransport(handler))

    result = fetch_raw_hour("EURUSD", dt, client=client, cache_dir=cache_dir)

    assert result == b""
    path = cache_module.cache_path("EURUSD", dt, cache_dir)
    assert cache_module.read_cached(path) == b""  # cached, not absent


def test_fetch_raw_hour_retries_then_succeeds_on_transient_5xx(tmp_path, monkeypatch):
    monkeypatch.setattr("data_ingestion.fetcher.time.sleep", lambda _seconds: None)
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] < 3:
            return httpx.Response(503)
        return httpx.Response(200, content=b"succeeded-on-retry")

    cache_dir = str(tmp_path)
    dt = datetime(2026, 8, 24, 10, tzinfo=timezone.utc)
    client = httpx.Client(transport=httpx.MockTransport(handler))

    result = fetch_raw_hour("EURUSD", dt, client=client, cache_dir=cache_dir, max_retries=3)

    assert result == b"succeeded-on-retry"
    assert attempts["count"] == 3


def test_fetch_raw_hour_gives_up_after_max_retries(tmp_path, monkeypatch):
    monkeypatch.setattr("data_ingestion.fetcher.time.sleep", lambda _seconds: None)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    cache_dir = str(tmp_path)
    dt = datetime(2026, 8, 24, 10, tzinfo=timezone.utc)
    client = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        fetch_raw_hour("EURUSD", dt, client=client, cache_dir=cache_dir, max_retries=3)


# ---------------------------------------------------------------------------
# symbols_point_values.py
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "symbol,expected",
    [("EURUSD", 100000.0), ("GBPUSD", 100000.0), ("USDJPY", 1000.0), ("EURJPY", 1000.0), ("XAUUSD", 1000.0), ("XAGUSD", 1000.0)],
)
def test_point_value_table(symbol, expected):
    assert point_value(symbol) == expected


# ---------------------------------------------------------------------------
# aggregator.py
# ---------------------------------------------------------------------------


def test_ticks_to_1m_candles_splits_on_minute_boundary():
    m0 = int(datetime(2026, 8, 24, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    m1 = int(datetime(2026, 8, 24, 10, 1, 0, tzinfo=timezone.utc).timestamp())
    ticks = [
        RawTick(timestamp_utc=m0, ask=1.1010, bid=1.1008, ask_volume=1, bid_volume=1),
        RawTick(timestamp_utc=m0 + 30, ask=1.1020, bid=1.1018, ask_volume=1, bid_volume=1),
        RawTick(timestamp_utc=m1, ask=1.1030, bid=1.1028, ask_volume=1, bid_volume=1),
    ]
    candles = ticks_to_1m_candles(ticks, "EURUSD")
    assert len(candles) == 2
    first, second = candles
    assert first.timestamp_utc == m0
    assert first.timeframe == "1m"
    assert first.volume == 2
    assert first.price_kind == PriceKind.BID_ASK
    assert first.open == pytest.approx((1.1010 + 1.1008) / 2)
    assert first.close == pytest.approx((1.1020 + 1.1018) / 2)
    assert first.high == pytest.approx((1.1020 + 1.1018) / 2)
    assert first.low == pytest.approx((1.1010 + 1.1008) / 2)
    assert first.bid_open == 1.1008 and first.bid_close == 1.1018
    assert first.ask_open == 1.1010 and first.ask_close == 1.1020
    assert second.timestamp_utc == m1
    assert second.volume == 1


def test_aggregate_to_timeframes_includes_1m_unchanged_and_derives_others():
    m0 = int(datetime(2026, 8, 24, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    ticks = [RawTick(timestamp_utc=m0, ask=1.1, bid=1.0999, ask_volume=1, bid_volume=1)]
    base_1m = ticks_to_1m_candles(ticks, "EURUSD")
    result = aggregate_to_timeframes(base_1m, ["1m", "5m"])
    assert result["1m"] is base_1m
    assert len(result["5m"]) == 1
    assert result["5m"][0].timeframe == "5m"


# ---------------------------------------------------------------------------
# importer.py - temp DuckDB file, never the real data.duckdb
# ---------------------------------------------------------------------------


@pytest.fixture
def con(tmp_path):
    """A private, from-scratch DuckDB file with only the two tables
    importer.py actually touches - mirrors build_db.py's exact `candles`/
    `symbols` schema (including `volume`, which the real table has always
    had - see build_db.py) so the migration/insert statements are tested
    against something structurally real, without needing the full dataset."""
    db_path = str(tmp_path / "test.duckdb")
    connection = duckdb.connect(db_path)
    connection.execute(
        "CREATE TABLE candles (symbol VARCHAR, timeframe VARCHAR, bar_index INTEGER, "
        "time BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE)"
    )
    connection.execute("CREATE TABLE symbols (symbol VARCHAR PRIMARY KEY, label VARCHAR)")
    yield connection
    connection.close()


def _candle(ts: int, price: float = 1.1, symbol: str = "EURUSD") -> Candle:
    return Candle(
        instrument_id=symbol, timeframe="1m", timestamp_utc=ts,
        open=price, high=price + 0.0005, low=price - 0.0005, close=price,
        volume=1, bid_open=price - 0.0001, bid_high=price + 0.0004, bid_low=price - 0.0006, bid_close=price - 0.0001,
        ask_open=price + 0.0001, ask_high=price + 0.0006, ask_low=price - 0.0004, ask_close=price + 0.0001,
        source="dukascopy", price_kind=PriceKind.BID_ASK,
    )


def test_ensure_schema_migration_adds_bid_ask_columns(con):
    ensure_schema_migration(con)
    columns = {row[1] for row in con.execute("PRAGMA table_info('candles')").fetchall()}
    for col in ("bid_open", "bid_high", "bid_low", "bid_close", "ask_open", "ask_high", "ask_low", "ask_close"):
        assert col in columns


def test_ensure_schema_migration_is_idempotent(con):
    ensure_schema_migration(con)
    ensure_schema_migration(con)  # must not raise the second time
    columns = [row[1] for row in con.execute("PRAGMA table_info('candles')").fetchall()]
    assert columns.count("bid_open") == 1  # not duplicated


def test_ensure_symbol_registered_then_conflict_is_a_noop(con):
    ensure_symbol_registered(con, "EURUSD", "EURUSD")
    ensure_symbol_registered(con, "EURUSD", "EURUSD")  # must not raise on the PK conflict
    rows = con.execute("SELECT symbol, label FROM symbols WHERE symbol = 'EURUSD'").fetchall()
    assert rows == [("EURUSD", "EURUSD")]


def test_get_coverage_returns_none_when_nothing_stored(con):
    assert get_coverage(con, "EURUSD", "1m") is None


def test_upsert_first_population_writes_all_rows_with_contiguous_bar_index(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    candles = [_candle(base), _candle(base + 60), _candle(base + 120)]
    written = upsert_symbol_timeframe(con, "EURUSD", "1m", candles)
    assert written == 3
    rows = con.execute(
        "SELECT bar_index, time, bid_open, ask_open FROM candles WHERE symbol='EURUSD' AND timeframe='1m' ORDER BY bar_index"
    ).fetchall()
    assert [r[0] for r in rows] == [0, 1, 2]
    assert [r[1] for r in rows] == [base, base + 60, base + 120]
    assert rows[0][2] is not None and rows[0][3] is not None  # bid/ask actually populated


def test_upsert_rerun_with_same_candles_produces_no_duplicates(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    candles = [_candle(base), _candle(base + 60)]
    upsert_symbol_timeframe(con, "EURUSD", "1m", candles)
    upsert_symbol_timeframe(con, "EURUSD", "1m", candles)  # identical rerun
    count = con.execute("SELECT COUNT(*) FROM candles WHERE symbol='EURUSD' AND timeframe='1m'").fetchone()[0]
    assert count == 2  # unchanged, not doubled


def test_upsert_fast_path_appends_without_touching_existing_bar_index(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    upsert_symbol_timeframe(con, "EURUSD", "1m", [_candle(base), _candle(base + 60)])
    # A strictly-newer candle - must hit the fast (append) path.
    upsert_symbol_timeframe(con, "EURUSD", "1m", [_candle(base + 120)])
    rows = con.execute(
        "SELECT bar_index, time FROM candles WHERE symbol='EURUSD' AND timeframe='1m' ORDER BY bar_index"
    ).fetchall()
    assert [r[0] for r in rows] == [0, 1, 2]
    assert [r[1] for r in rows] == [base, base + 60, base + 120]


def test_upsert_slow_path_backfill_renumbers_bar_index_chronologically(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    # Populate starting at `base` first...
    upsert_symbol_timeframe(con, "EURUSD", "1m", [_candle(base), _candle(base + 60)])
    # ...then backfill an OLDER candle - must hit the slow (merge/renumber) path.
    upsert_symbol_timeframe(con, "EURUSD", "1m", [_candle(base - 60)])
    rows = con.execute(
        "SELECT bar_index, time FROM candles WHERE symbol='EURUSD' AND timeframe='1m' ORDER BY bar_index"
    ).fetchall()
    assert [r[0] for r in rows] == [0, 1, 2]
    assert [r[1] for r in rows] == [base - 60, base, base + 60]  # chronological, oldest first


def test_upsert_only_touches_the_requested_symbol_timeframe_partition(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    upsert_symbol_timeframe(con, "GBPUSD", "1h", [_candle(base, symbol="GBPUSD")])
    upsert_symbol_timeframe(con, "EURUSD", "1m", [_candle(base)])
    gbp_count = con.execute("SELECT COUNT(*) FROM candles WHERE symbol='GBPUSD' AND timeframe='1h'").fetchone()[0]
    assert gbp_count == 1  # untouched by the EURUSD/1m write


# ---------------------------------------------------------------------------
# orchestrator.py: compute_fetch_ranges (pure logic, table-driven)
# ---------------------------------------------------------------------------


def _dt(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


def test_compute_fetch_ranges_no_existing_coverage_fetches_everything():
    ranges = compute_fetch_ranges(_dt(2026, 8, 1), _dt(2026, 8, 8), None)
    assert ranges == [(_dt(2026, 8, 1), _dt(2026, 8, 8))]


def test_compute_fetch_ranges_pure_extend_forward():
    existing_max = int(_dt(2026, 8, 4).timestamp())
    coverage = (int(_dt(2026, 8, 1).timestamp()), existing_max)
    ranges = compute_fetch_ranges(_dt(2026, 8, 1), _dt(2026, 8, 8), coverage)
    assert len(ranges) == 1
    assert ranges[0][0] > _dt(2026, 8, 4)
    assert ranges[0][1] == _dt(2026, 8, 8)


def test_compute_fetch_ranges_pure_backfill_older():
    existing_min = int(_dt(2026, 8, 4).timestamp())
    coverage = (existing_min, int(_dt(2026, 8, 8).timestamp()))
    ranges = compute_fetch_ranges(_dt(2026, 8, 1), _dt(2026, 8, 8), coverage)
    assert len(ranges) == 1
    assert ranges[0][0] == _dt(2026, 8, 1)
    assert ranges[0][1] <= _dt(2026, 8, 4)


def test_compute_fetch_ranges_fully_covered_is_a_noop():
    coverage = (int(_dt(2026, 8, 1).timestamp()), int(_dt(2026, 8, 8).timestamp()))
    ranges = compute_fetch_ranges(_dt(2026, 8, 2), _dt(2026, 8, 7), coverage)
    assert ranges == []


# ---------------------------------------------------------------------------
# orchestrator.py: run_ingestion end-to-end (real temp DuckDB file, mocked
# HTTP transport only - no real network, no real data.duckdb)
# ---------------------------------------------------------------------------


def test_run_ingestion_backup_succeeds_before_opening_the_connection(tmp_path):
    """Regression test for a real bug found running the actual POC: the
    backup copy must happen BEFORE opening the DuckDB read-write
    connection to the same path. DuckDB holds an exclusive OS-level lock
    on a file it has open for writing, and on Windows specifically,
    shutil.copy2 cannot copy a file this same process already holds open
    - backing up AFTER connect() self-inflicts a PermissionError on
    Windows (harmless-looking on POSIX, which is why this wasn't caught
    until an actual Windows run). This test creates a real DuckDB file
    with the minimal candles/symbols schema and runs the real backup step
    through run_ingestion() end-to-end (mocking only the HTTP transport,
    which returns 404/no-ticks for every hour so the run completes fast
    without fetching real data) - the meaningful assertion is that this
    does not raise and a real, non-empty backup file exists afterward."""
    db_path = str(tmp_path / "test.duckdb")
    setup_con = duckdb.connect(db_path)
    setup_con.execute(
        "CREATE TABLE candles (symbol VARCHAR, timeframe VARCHAR, bar_index INTEGER, "
        "time BIGINT, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE)"
    )
    setup_con.execute("CREATE TABLE symbols (symbol VARCHAR PRIMARY KEY, label VARCHAR)")
    setup_con.close()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)  # every hour "has no ticks" - no real fetch needed

    client = httpx.Client(transport=httpx.MockTransport(handler))
    results = run_ingestion(
        symbols=["EURUSD"],
        start=_dt(2026, 8, 24),
        end=_dt(2026, 8, 24, 1),  # a single hour - fast
        timeframes=["1m"],
        db_path=db_path,
        cache_dir=str(tmp_path / "cache"),
        client=client,
        backup=True,
    )

    assert len(results) == 1
    backups = list(tmp_path.glob("test.duckdb.bak-*"))
    assert len(backups) == 1
    assert backups[0].stat().st_size > 0


# ---------------------------------------------------------------------------
# orchestrator.py: reaggregate_higher_timeframes - derives higher timeframes
# from 1m candles ALREADY STORED in `candles`, no network/Dukascopy call.
# ---------------------------------------------------------------------------


def _insert_1m(con, symbol: str, ts: int, price: float, with_bid_ask: bool = True, volume: int | None = None) -> None:
    """Directly inserts a bare 1m row, bypassing upsert_symbol_timeframe -
    these tests are about reaggregate_higher_timeframes reading FROM
    `candles`, not about the insertion path itself (already covered above).
    `volume` defaults to None (an older/pre-migration-style row with no
    volume) - pass it explicitly to test volume propagation."""
    bar_index = con.execute(
        "SELECT COALESCE(MAX(bar_index), -1) + 1 FROM candles WHERE symbol=? AND timeframe='1m'", [symbol]
    ).fetchone()[0]
    if with_bid_ask:
        con.execute(
            "INSERT INTO candles (symbol, timeframe, bar_index, time, open, high, low, close, volume, "
            "bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close) "
            "VALUES (?, '1m', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [symbol, bar_index, ts, price, price + 0.0005, price - 0.0005, price, volume,
             price - 0.0001, price + 0.0004, price - 0.0006, price - 0.0001,
             price + 0.0001, price + 0.0006, price - 0.0004, price + 0.0001],
        )
    else:
        con.execute(
            "INSERT INTO candles (symbol, timeframe, bar_index, time, open, high, low, close, volume) "
            "VALUES (?, '1m', ?, ?, ?, ?, ?, ?, ?)",
            [symbol, bar_index, ts, price, price + 0.0005, price - 0.0005, price, volume],
        )


def test_reaggregate_first_population_builds_5m_from_1m(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    # 5 one-minute candles spanning exactly one 5m bucket [10:00, 10:05).
    for i in range(5):
        _insert_1m(con, "EURUSD", base + i * 60, 1.1000 + i * 0.0001)

    written = reaggregate_higher_timeframes(con, "EURUSD", ["5m"])

    assert written == {"5m": 1}
    row = con.execute(
        "SELECT time, open, high, low, close, bid_open, ask_open FROM candles WHERE symbol='EURUSD' AND timeframe='5m'"
    ).fetchone()
    assert row[0] == base  # bucket start
    assert row[1] == pytest.approx(1.1000)  # open = first 1m open
    assert row[2] == pytest.approx(1.1004 + 0.0005)  # high = max of members' highs
    assert row[3] == pytest.approx(1.1000 - 0.0005)  # low = min of members' lows
    assert row[4] == pytest.approx(1.1004)  # close = last 1m close
    assert row[5] is not None and row[6] is not None  # bid/ask aggregated through


def test_reaggregate_never_touches_existing_independently_sourced_rows(con):
    """Simulates the real production scenario: an existing 5m row from an
    independent CSV import (no bid/ask), with NEW 1m data extending past
    it. Only a brand-new bucket after the existing one must be written -
    the old row must be byte-for-byte untouched, never renumbered."""
    ensure_schema_migration(con)
    old_bucket_start = int(datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc).timestamp())
    con.execute(
        "INSERT INTO candles (symbol, timeframe, bar_index, time, open, high, low, close) VALUES "
        "('EURUSD', '5m', 0, ?, 1.05, 1.051, 1.049, 1.0505)",
        [old_bucket_start],
    )
    new_bucket_start = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    for i in range(5):
        _insert_1m(con, "EURUSD", new_bucket_start + i * 60, 1.10 + i * 0.0001)

    written = reaggregate_higher_timeframes(con, "EURUSD", ["5m"])

    assert written == {"5m": 1}
    rows = con.execute(
        "SELECT bar_index, time, open, bid_open FROM candles WHERE symbol='EURUSD' AND timeframe='5m' ORDER BY bar_index"
    ).fetchall()
    assert len(rows) == 2
    assert rows[0] == (0, old_bucket_start, 1.05, None)  # untouched, still NULL bid/ask
    assert rows[1][1] == new_bucket_start
    assert rows[1][3] is not None  # the new bucket has real bid/ask


def test_reaggregate_is_a_noop_when_no_new_1m_data_exists_beyond_coverage(con):
    ensure_schema_migration(con)
    ts = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    _insert_1m(con, "EURUSD", ts, 1.10)
    reaggregate_higher_timeframes(con, "EURUSD", ["5m"])  # first pass creates the bucket
    written_again = reaggregate_higher_timeframes(con, "EURUSD", ["5m"])  # no new 1m data since
    assert written_again == {"5m": 0}
    count = con.execute("SELECT COUNT(*) FROM candles WHERE symbol='EURUSD' AND timeframe='5m'").fetchone()[0]
    assert count == 1  # unchanged


def test_reaggregate_derives_multiple_timeframes_in_one_call(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 0, 0, tzinfo=timezone.utc).timestamp())  # midnight - aligns every timeframe
    for i in range(120):  # 2 hours of 1m data
        _insert_1m(con, "EURUSD", base + i * 60, 1.10)

    written = reaggregate_higher_timeframes(con, "EURUSD", ["5m", "15m", "30m", "1h"])

    assert written == {"5m": 24, "15m": 8, "30m": 4, "1h": 2}


# ---------------------------------------------------------------------------
# Volume (tick-count activity): end-to-end correctness for 1h/1d specifically
# - this task's product scope. The underlying mechanism (aggregate_candles(),
# upsert_symbol_timeframe()) is timeframe-agnostic by construction (same code
# path serves every timeframe), so these tests exercise 1h/1d deliberately
# rather than because the code itself special-cases them.
#
# Definition under test throughout: volume = number of Dukascopy ticks
# contributing to the candle (tick-count activity), never centralized/real
# traded volume - forex is OTC.
# ---------------------------------------------------------------------------


def _tick(ts: int, ask: float = 1.1005, bid: float = 1.1000) -> RawTick:
    return RawTick(timestamp_utc=ts, ask=ask, bid=bid, ask_volume=1.0, bid_volume=1.0)


def test_synthetic_ticks_aggregate_to_correct_1h_volume():
    """10 ticks in one minute + 7 ticks in another, both inside the same
    clock hour - 1h volume must equal the total tick count for that hour
    (17), via the same ticks_to_1m_candles -> aggregate_to_timeframes path
    run_ingestion() itself uses, no separate test-only aggregation logic."""
    hour_start = int(datetime(2026, 8, 24, 10, 0, 0, tzinfo=timezone.utc).timestamp())
    minute_a = hour_start  # 10:00
    minute_b = hour_start + 3 * 60  # 10:03, same hour
    ticks = [_tick(minute_a + i) for i in range(10)] + [_tick(minute_b + i) for i in range(7)]

    base_1m = ticks_to_1m_candles(ticks, "EURUSD")
    by_tf = aggregate_to_timeframes(base_1m, ["1h"])

    assert len(by_tf["1h"]) == 1
    assert by_tf["1h"][0].timeframe == "1h"
    assert by_tf["1h"][0].volume == 17


def test_synthetic_1h_candles_aggregate_to_correct_1d_volume():
    """Four already-aggregated 1h Candle objects (volumes 10/7/5/8, as
    reaggregate_higher_timeframes would read them back from `candles`) roll
    up to a 1d volume of 30 via app/marketdata/timeframes.py's existing
    aggregate_candles() - never a second aggregation implementation."""
    day_start = int(datetime(2026, 8, 24, 0, 0, 0, tzinfo=timezone.utc).timestamp())
    hourly_volumes = [10, 7, 5, 8]
    hour_candles = [
        Candle(
            instrument_id="EURUSD", timeframe="1h", timestamp_utc=day_start + i * 3600,
            open=1.1, high=1.1005, low=1.0995, close=1.1, volume=v,
            source="dukascopy", price_kind=PriceKind.MID,
        )
        for i, v in enumerate(hourly_volumes)
    ]

    daily = aggregate_candles(hour_candles, "1d")

    assert len(daily) == 1
    assert daily[0].volume == sum(hourly_volumes) == 30


def test_upsert_1h_candle_with_volume_round_trips_through_db(con):
    ensure_schema_migration(con)
    ts = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    candle = Candle(
        instrument_id="EURUSD", timeframe="1h", timestamp_utc=ts,
        open=1.1, high=1.1010, low=1.0990, close=1.1005, volume=42,
        bid_open=1.0999, bid_high=1.1009, bid_low=1.0989, bid_close=1.1004,
        ask_open=1.1001, ask_high=1.1011, ask_low=1.0991, ask_close=1.1006,
        source="dukascopy", price_kind=PriceKind.BID_ASK,
    )
    upsert_symbol_timeframe(con, "EURUSD", "1h", [candle])
    row = con.execute(
        "SELECT open, high, low, close, volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h'"
    ).fetchone()
    assert row == (1.1, 1.1010, 1.0990, 1.1005, 42)


def test_upsert_1d_candle_with_volume_round_trips_through_db(con):
    ensure_schema_migration(con)
    ts = int(datetime(2026, 8, 24, 0, 0, tzinfo=timezone.utc).timestamp())
    candle = Candle(
        instrument_id="EURUSD", timeframe="1d", timestamp_utc=ts,
        open=1.1, high=1.102, low=1.098, close=1.101, volume=1234,
        source="dukascopy", price_kind=PriceKind.MID,
    )
    upsert_symbol_timeframe(con, "EURUSD", "1d", [candle])
    row = con.execute("SELECT volume FROM candles WHERE symbol='EURUSD' AND timeframe='1d'").fetchone()
    assert row == (1234,)


def test_upsert_fast_path_append_preserves_volume(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc).timestamp())
    first = Candle(
        instrument_id="EURUSD", timeframe="1h", timestamp_utc=base,
        open=1.1, high=1.101, low=1.099, close=1.1005, volume=10,
        source="dukascopy", price_kind=PriceKind.MID,
    )
    second = Candle(
        instrument_id="EURUSD", timeframe="1h", timestamp_utc=base + 3600,
        open=1.1005, high=1.102, low=1.0995, close=1.101, volume=20,
        source="dukascopy", price_kind=PriceKind.MID,
    )
    upsert_symbol_timeframe(con, "EURUSD", "1h", [first])
    upsert_symbol_timeframe(con, "EURUSD", "1h", [second])  # strictly newer -> fast path
    rows = con.execute(
        "SELECT time, volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h' ORDER BY time"
    ).fetchall()
    assert rows == [(base, 10), (base + 3600, 20)]


def test_overlap_merge_never_wipes_existing_untouched_volume(con):
    """Regression test for the merge-path bug found during the historical
    audit: upsert_symbol_timeframe's slow (DELETE+reinsert) path used to
    omit `volume` from both its SELECT and INSERT, silently turning every
    existing row's volume into NULL whenever an overlap/backfill write
    touched that (symbol, timeframe) partition - even rows the new write
    never intended to touch. Seeds a 1h partition with real (CSV-style, no
    bid/ask) volume, exactly like the real EURUSD 1h dataset, then runs an
    overlapping write that only actually collides with ONE of the seeded
    timestamps."""
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc).timestamp())
    for i, vol in enumerate([100, 200, 300]):  # base, base+1h, base+2h
        con.execute(
            "INSERT INTO candles (symbol, timeframe, bar_index, time, open, high, low, close, volume) "
            "VALUES ('EURUSD', '1h', ?, ?, 1.1, 1.101, 1.099, 1.1005, ?)",
            [i, base + i * 3600, vol],
        )

    new_candle_colliding = Candle(  # same timestamp as the middle seeded row
        instrument_id="EURUSD", timeframe="1h", timestamp_utc=base + 3600,
        open=1.1, high=1.1015, low=1.0995, close=1.101, volume=999,
        bid_open=1.0999, bid_high=1.1014, bid_low=1.0994, bid_close=1.1009,
        ask_open=1.1001, ask_high=1.1016, ask_low=1.0996, ask_close=1.1011,
        source="dukascopy", price_kind=PriceKind.BID_ASK,
    )
    new_candle_extending = Candle(  # one hour past the existing max - genuinely new
        instrument_id="EURUSD", timeframe="1h", timestamp_utc=base + 3 * 3600,
        open=1.101, high=1.1020, low=1.1000, close=1.1015, volume=55,
        bid_open=1.1009, bid_high=1.1019, bid_low=1.0999, bid_close=1.1014,
        ask_open=1.1011, ask_high=1.1021, ask_low=1.1001, ask_close=1.1016,
        source="dukascopy", price_kind=PriceKind.BID_ASK,
    )
    upsert_symbol_timeframe(con, "EURUSD", "1h", [new_candle_colliding, new_candle_extending])

    rows = con.execute(
        "SELECT time, volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h' ORDER BY time"
    ).fetchall()
    volumes_by_time = dict(rows)

    assert volumes_by_time[base] == 100  # untouched existing row - preserved, not NULL
    assert volumes_by_time[base + 3600] == 999  # collided - new Dukascopy volume wins
    assert volumes_by_time[base + 2 * 3600] == 300  # untouched existing row - preserved
    assert volumes_by_time[base + 3 * 3600] == 55  # brand-new row - has its own volume
    assert None not in volumes_by_time.values()  # the core invariant this fix guarantees


def test_upsert_1h_rerun_is_idempotent_including_volume(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 8, 0, tzinfo=timezone.utc).timestamp())
    candles = [
        Candle(
            instrument_id="EURUSD", timeframe="1h", timestamp_utc=base + i * 3600,
            open=1.1, high=1.101, low=1.099, close=1.1005, volume=10 + i,
            bid_open=1.0999, bid_high=1.1009, bid_low=1.0989, bid_close=1.1004,
            ask_open=1.1001, ask_high=1.1011, ask_low=1.0991, ask_close=1.1006,
            source="dukascopy", price_kind=PriceKind.BID_ASK,
        )
        for i in range(3)
    ]
    upsert_symbol_timeframe(con, "EURUSD", "1h", candles)
    upsert_symbol_timeframe(con, "EURUSD", "1h", candles)  # identical rerun

    rows = con.execute(
        "SELECT time, open, high, low, close, volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h' ORDER BY time"
    ).fetchall()
    assert len(rows) == 3  # no duplicates
    assert [r[5] for r in rows] == [10, 11, 12]  # volume unchanged, not doubled/re-summed
    assert [r[1] for r in rows] == [1.1, 1.1, 1.1]  # OHLC unchanged too


def test_reaggregate_1h_sums_1m_tick_counts_into_volume(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    volumes = [10, 7, 5, 8]
    for i, vol in enumerate(volumes):
        _insert_1m(con, "EURUSD", base + i * 60, 1.10 + i * 0.0001, volume=vol)

    written = reaggregate_higher_timeframes(con, "EURUSD", ["1h"])

    assert written == {"1h": 1}
    row = con.execute("SELECT volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h'").fetchone()
    assert row[0] == sum(volumes) == 30


def test_reaggregate_1d_sums_1m_tick_counts_into_volume(con):
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 0, 0, tzinfo=timezone.utc).timestamp())
    volumes = [3, 4, 5]
    for i, vol in enumerate(volumes):
        _insert_1m(con, "EURUSD", base + i * 60, 1.10, volume=vol)

    written = reaggregate_higher_timeframes(con, "EURUSD", ["1d"])

    assert written == {"1d": 1}
    row = con.execute("SELECT volume FROM candles WHERE symbol='EURUSD' AND timeframe='1d'").fetchone()
    assert row[0] == sum(volumes) == 12


def test_reaggregate_1h_volume_is_none_when_any_member_1m_row_has_no_volume(con):
    """Matches aggregate_candles()'s own documented rule: summing a real
    count together with a genuinely-missing one and calling the result real
    would be fabrication - a partial-volume hour must stay None, never
    silently treated as zero or partially summed."""
    ensure_schema_migration(con)
    base = int(datetime(2026, 8, 24, 10, 0, tzinfo=timezone.utc).timestamp())
    _insert_1m(con, "EURUSD", base, 1.10, volume=10)
    _insert_1m(con, "EURUSD", base + 60, 1.1001, volume=None)  # older row, no volume

    reaggregate_higher_timeframes(con, "EURUSD", ["1h"])

    row = con.execute("SELECT volume FROM candles WHERE symbol='EURUSD' AND timeframe='1h'").fetchone()
    assert row[0] is None
