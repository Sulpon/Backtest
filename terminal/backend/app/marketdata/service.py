"""
MarketDataService - the seam between callers (API layer, Replay Engine) and
the provider abstraction:

    Database <-> MarketDataService -> MarketDataProvider -> normalize -> validate -> store

Owns incremental sync: a request for a range that's already stored locally
never touches the provider at all; a partially-covered range only fetches
the missing part.
"""
from __future__ import annotations

import logging

from . import repository
from .provider import MarketDataProvider
from .symbols import parse_symbol
from .timeframes import BASE_TIMEFRAME, TIMEFRAME_SECONDS, aggregate_candles
from .validation import ValidationLevel, validate_candles
from .models import Candle

logger = logging.getLogger(__name__)


class MarketDataService:
    def __init__(self, provider: MarketDataProvider):
        self._provider = provider

    def get_candles(self, symbol: str, timeframe: str, start: int, end: int) -> list[Candle]:
        """The one entry point callers (eventually the Replay Engine, via a
        FastAPI route) use. Ensures [start, end) is covered locally first -
        syncing only whatever part is missing - then returns it, aggregated
        from BASE_TIMEFRAME if `timeframe` isn't the base itself."""
        self.sync(symbol, start, end)
        con = repository.get_rw_connection()
        try:
            base = repository.read_candles(con, symbol, BASE_TIMEFRAME, start, end)
        finally:
            con.close()
        if timeframe == BASE_TIMEFRAME:
            return base
        return aggregate_candles(base, timeframe)

    def sync(self, symbol: str, start: int, end: int) -> int:
        """Fetch and store only whatever part of [start, end) isn't already
        in the database for this symbol's base timeframe. Returns how many
        new candles were stored. Every provider call this makes is recorded
        as a data_sync_jobs row, successful or not."""
        con = repository.get_rw_connection()
        try:
            repository.ensure_schema(con)
            coverage = repository.get_coverage(con, symbol, BASE_TIMEFRAME)
            missing_ranges = _missing_ranges(start, end, coverage, TIMEFRAME_SECONDS[BASE_TIMEFRAME])
            total_new = 0
            for range_start, range_end in missing_ranges:
                total_new += self._sync_range(con, symbol, range_start, range_end)
            return total_new
        finally:
            con.close()

    def _sync_range(self, con, symbol: str, range_start: int, range_end: int) -> int:
        try:
            candles = self._provider.get_candles(symbol, BASE_TIMEFRAME, range_start, range_end)
        except Exception as exc:  # provider/network failure - record and re-raise so the
            # caller (and eventually the API layer) can fall back to whatever's cached
            repository.record_sync_job(
                con, instrument_id=symbol, timeframe=BASE_TIMEFRAME, provider=self._provider.name,
                requested_start=range_start, requested_end=range_end, status="failed",
                candles_synced=0, validation_level=None, error_message=str(exc),
            )
            raise

        if not candles:
            repository.record_sync_job(
                con, instrument_id=symbol, timeframe=BASE_TIMEFRAME, provider=self._provider.name,
                requested_start=range_start, requested_end=range_end, status="success",
                candles_synced=0, validation_level=ValidationLevel.VALID.value, error_message=None,
            )
            return 0

        result = validate_candles(candles, TIMEFRAME_SECONDS[BASE_TIMEFRAME])
        if result.level == ValidationLevel.INVALID:
            messages = [i.message for i in result.issues if i.level == ValidationLevel.INVALID][:5]
            logger.error("Rejected %d candles for %s %s: %s", len(candles), symbol, BASE_TIMEFRAME, messages)
            repository.record_sync_job(
                con, instrument_id=symbol, timeframe=BASE_TIMEFRAME, provider=self._provider.name,
                requested_start=range_start, requested_end=range_end, status="failed",
                candles_synced=0, validation_level=result.level.value, error_message="; ".join(messages),
            )
            return 0

        if result.level == ValidationLevel.WARNING:
            messages = [i.message for i in result.issues if i.level == ValidationLevel.WARNING][:5]
            logger.warning("%d candles for %s %s have warnings: %s", len(candles), symbol, BASE_TIMEFRAME, messages)

        stored = repository.upsert_candles(con, candles)
        repository.record_sync_job(
            con, instrument_id=symbol, timeframe=BASE_TIMEFRAME, provider=self._provider.name,
            requested_start=range_start, requested_end=range_end, status="success",
            candles_synced=stored, validation_level=result.level.value, error_message=None,
        )
        return stored

    def sync_instruments(self) -> int:
        """Populate/refresh the `instruments` table from whatever the
        provider's own instrument-list call reports right now - metadata
        (pip size, precision, ...) always comes from here, never hardcoded."""
        con = repository.get_rw_connection()
        try:
            repository.ensure_schema(con)
            repository.ensure_data_source(con, self._provider.name, "provider", self._provider.name.upper())
            count = 0
            for inst in self._provider.list_instruments():
                parts = parse_symbol(inst.symbol)
                repository.upsert_instrument(
                    con,
                    instrument_id=inst.symbol,
                    symbol=inst.symbol,
                    provider_symbol=inst.provider_symbol,
                    base_currency=parts.base,
                    quote_currency=parts.quote,
                    asset_class=parts.asset_class,
                    tick_size=10 ** inst.pip_location if inst.pip_location is not None else None,
                    pip_size=10 ** inst.pip_location if inst.pip_location is not None else None,
                    provider=self._provider.name,
                )
                count += 1
            return count
        finally:
            con.close()


def _missing_ranges(
    start: int, end: int, coverage: tuple[int, int] | None, base_seconds: int
) -> list[tuple[int, int]]:
    """Incremental sync's core decision: given what's already stored
    ([coverage[0], coverage[1]], both candle OPEN timestamps) and what's
    requested ([start, end)), return only the sub-range(s) that actually
    need fetching - at most two (before and after existing coverage), never
    re-fetching the middle.

    coverage[1] is the LAST STORED CANDLE'S open time, not the end of what
    it covers - a bar opening at coverage[1] represents data up through
    coverage[1] + base_seconds. Comparing `end` directly against
    coverage[1] (instead of that adjusted boundary) would treat a request
    for an already-fully-covered range as having a dangling one-bar-wide
    "gap" at the tail every time, silently re-fetching it - exactly the
    repeated-download behaviour incremental sync exists to avoid.
    """
    if coverage is None:
        return [(start, end)]
    covered_start, covered_through = coverage[0], coverage[1] + base_seconds
    ranges: list[tuple[int, int]] = []
    if start < covered_start:
        ranges.append((start, covered_start))
    if end > covered_through:
        ranges.append((max(start, covered_through), end))
    return ranges
