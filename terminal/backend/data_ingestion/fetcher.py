"""
Dukascopy's public, unauthenticated tick-file mirror. No official Python/
REST API exists for this - Dukascopy's only official programmatic
interface is the JForex Java Strategy API, which needs their trading
platform/account and isn't usable from Python/FastAPI. This mirror
(datafeed.dukascopy.com) is what every tool - official JForex included,
and every unofficial Python package - ultimately reads. See
C:\\Users\\sulta\\.claude\\plans\\compiled-munching-pancake.md for the full
research trail.

URL: http://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YEAR}/{MONTH_0IDX:02d}/{DAY:02d}/{HOUR:02d}h_ticks.bi5
Month is 0-INDEXED - January is "00". This is the single most common
mistake reimplementing this fetch, so it has its own dedicated test.

File format: LZMA-compressed. Decompressed payload is a stream of fixed
20-byte big-endian records: int32 ms-offset-from-hour-start, int32 raw ask
price, int32 raw bid price, float32 ask volume, float32 bid volume. Raw
prices need dividing by a point value (symbols_point_values.point_value) -
100000 for standard pairs, 1000 for JPY pairs and metals (empirically
verified against real downloaded samples, see symbols_point_values.py's
own docstring).

No documented rate limit (it isn't a formal API), so this fetcher behaves
conservatively: bounded retry/backoff on transport errors and 5xx only - a
404 means "no ticks this hour" (a real, expected, non-error outcome for
market-closed hours), never retried, never an error.
"""
from __future__ import annotations

import lzma
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from . import cache as cache_module
from .symbols_point_values import point_value

_TICK_RECORD_FORMAT = ">iiiff"  # ms_offset, raw_ask, raw_bid, ask_volume, bid_volume
_TICK_RECORD_SIZE = struct.calcsize(_TICK_RECORD_FORMAT)

# Confirmed empirically (running the actual POC): this mirror rate-limits
# with a plain 429 and no Retry-After header, so backoff has to guess a
# reasonable cooldown rather than being told one. Longer/more attempts
# than the original 1/2/4s x3 - that budget proved too short against a
# real 429 hit during the POC.
_RETRY_DELAYS_SECONDS = (2.0, 5.0, 10.0, 20.0, 30.0)


@dataclass(frozen=True)
class RawTick:
    timestamp_utc: int  # unix seconds - truncated from the record's ms-offset; sub-second
    # ordering is preserved by list order (ticks are parsed/appended in file
    # order, already chronological), so nothing is lost for OHLC bucketing,
    # which never needs sub-second precision.
    ask: float
    bid: float
    ask_volume: float
    bid_volume: float


def build_url(symbol: str, dt: datetime) -> str:
    # https, not http - confirmed empirically (running the actual POC):
    # Dukascopy's server permanently redirects (301) http -> https, and
    # httpx's raise_for_status() treats an unfollowed redirect response as
    # an error. Using https directly avoids the extra round trip too.
    return (
        f"https://datafeed.dukascopy.com/datafeed/{symbol}/"
        f"{dt.year:04d}/{dt.month - 1:02d}/{dt.day:02d}/{dt.hour:02d}h_ticks.bi5"
    )


def fetch_raw_hour(
    symbol: str,
    dt: datetime,
    *,
    client: httpx.Client,
    cache_dir: str = cache_module.DEFAULT_CACHE_DIR,
    use_cache: bool = True,
    max_retries: int = 5,
) -> bytes:
    """Returns the raw (still-compressed) bytes for one symbol/hour, or
    b"" if that hour genuinely has no ticks (a 404, cached as such - not an
    error). Retries on network/5xx/429 failures, with 1s/2s/4s backoff (or
    longer if the server sends a Retry-After header on a 429 - confirmed
    empirically running the actual POC: this mirror DOES rate-limit
    despite having no documented SLA, exactly the risk this module's own
    "well-behaved client" design was already built for)."""
    path = cache_module.cache_path(symbol, dt, cache_dir)
    if use_cache:
        cached = cache_module.read_cached(path)
        if cached is not None:
            return cached

    url = build_url(symbol, dt)
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            response = client.get(url)
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt < max_retries - 1:
                time.sleep(_RETRY_DELAYS_SECONDS[min(attempt, len(_RETRY_DELAYS_SECONDS) - 1)])
                continue
            raise
        if response.status_code == 404:
            if use_cache:
                cache_module.write_cache(path, b"")
            return b""
        if response.status_code == 429 or response.status_code >= 500:
            last_exc = httpx.HTTPStatusError(
                f"{response.status_code} from {url}", request=response.request, response=response
            )
            if attempt < max_retries - 1:
                retry_after = response.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else None
                if delay is None:
                    delay = _RETRY_DELAYS_SECONDS[min(attempt, len(_RETRY_DELAYS_SECONDS) - 1)]
                time.sleep(delay)
                continue
            raise last_exc
        response.raise_for_status()
        raw = response.content
        if use_cache:
            cache_module.write_cache(path, raw)
        return raw
    raise last_exc  # pragma: no cover - unreachable, loop always returns or raises


def decompress_bi5(raw: bytes) -> bytes:
    if not raw:
        return b""
    return lzma.decompress(raw)


def parse_ticks(payload: bytes, symbol: str, hour_start_utc: int) -> list[RawTick]:
    if not payload:
        return []
    pv = point_value(symbol)
    ticks: list[RawTick] = []
    for ms_offset, raw_ask, raw_bid, ask_vol, bid_vol in struct.iter_unpack(_TICK_RECORD_FORMAT, payload):
        ticks.append(
            RawTick(
                timestamp_utc=hour_start_utc + ms_offset // 1000,
                ask=raw_ask / pv,
                bid=raw_bid / pv,
                ask_volume=ask_vol,
                bid_volume=bid_vol,
            )
        )
    return ticks


def fetch_ticks_for_hour(
    symbol: str,
    dt: datetime,
    *,
    client: httpx.Client,
    cache_dir: str = cache_module.DEFAULT_CACHE_DIR,
    use_cache: bool = True,
) -> list[RawTick]:
    raw = fetch_raw_hour(symbol, dt, client=client, cache_dir=cache_dir, use_cache=use_cache)
    payload = decompress_bi5(raw)
    hour_start = int(dt.replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc).timestamp())
    return parse_ticks(payload, symbol, hour_start)
