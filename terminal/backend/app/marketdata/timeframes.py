"""
Canonical timeframes the rest of the app speaks in, independent of what any
provider calls them. "1m" is the lowest base timeframe stored/synced from a
provider; every other timeframe is derived deterministically by
aggregate_candles() rather than fetched natively - even on providers (like
OANDA) that DO support higher granularities directly, so a chart never has
to wonder whether an H4 boundary came from the provider's own alignment
rules or this app's, and one stored series can serve every timeframe.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from .models import Candle

# Ordered lowest to highest. Seconds is None only for "1mo" - a calendar
# month has no fixed length, so it's bucketed by calendar month instead of
# a fixed-size division. "1mo" (not "1M") to avoid ever colliding with "1m"
# (minute) if a timeframe string is compared case-insensitively anywhere
# downstream (URL query params, a DB text column, ...).
TIMEFRAME_SECONDS: dict[str, Optional[int]] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "8h": 28800,
    "12h": 43200,
    "1d": 86400,
    "1w": 604800,
    "1mo": None,
}

BASE_TIMEFRAME = "1m"


def is_valid_timeframe(tf: str) -> bool:
    return tf in TIMEFRAME_SECONDS


def _bucket_start(ts: int, tf: str) -> int:
    """UTC-aligned bucket start for one candle's timestamp. Weekly buckets
    align to Monday 00:00 UTC - a fixed, documented convention for charting
    purposes, not an attempt to match any one broker's session/settlement
    week (which varies by broker and isn't needed here)."""
    seconds = TIMEFRAME_SECONDS[tf]
    if seconds is not None:
        return ts - (ts % seconds)
    d = datetime.fromtimestamp(ts, tz=timezone.utc)
    return int(d.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())


def aggregate_candles(base_candles: Iterable[Candle], target_timeframe: str) -> list[Candle]:
    """Deterministic OHLC rollup from BASE_TIMEFRAME candles to any higher
    timeframe: open = first candle's open, high = max high, low = min low,
    close = last candle's close, volume = sum - but ONLY when every member
    candle actually has a volume; summing a real count together with a
    missing one and calling the result real would be exactly the kind of
    silent fabrication the validation/candle-model rules forbid. Input must
    already be sorted ascending by timestamp; output preserves that order."""
    base_list = list(base_candles)
    if target_timeframe == BASE_TIMEFRAME:
        return base_list
    if not is_valid_timeframe(target_timeframe):
        raise ValueError(f"Unknown timeframe '{target_timeframe}'")

    buckets: dict[int, list[Candle]] = {}
    order: list[int] = []
    for c in base_list:
        bucket = _bucket_start(c.timestamp_utc, target_timeframe)
        if bucket not in buckets:
            buckets[bucket] = []
            order.append(bucket)
        buckets[bucket].append(c)

    out: list[Candle] = []
    for bucket in order:
        members = buckets[bucket]
        volumes = [m.volume for m in members]
        total_volume = sum(v for v in volumes if v is not None) if all(v is not None for v in volumes) else None
        bid_highs = [m.bid_high for m in members if m.bid_high is not None]
        bid_lows = [m.bid_low for m in members if m.bid_low is not None]
        ask_highs = [m.ask_high for m in members if m.ask_high is not None]
        ask_lows = [m.ask_low for m in members if m.ask_low is not None]
        out.append(
            Candle(
                instrument_id=members[0].instrument_id,
                timeframe=target_timeframe,
                timestamp_utc=bucket,
                open=members[0].open,
                high=max(m.high for m in members),
                low=min(m.low for m in members),
                close=members[-1].close,
                volume=total_volume,
                bid_open=members[0].bid_open,
                bid_high=max(bid_highs) if bid_highs else None,
                bid_low=min(bid_lows) if bid_lows else None,
                bid_close=members[-1].bid_close,
                ask_open=members[0].ask_open,
                ask_high=max(ask_highs) if ask_highs else None,
                ask_low=min(ask_lows) if ask_lows else None,
                ask_close=members[-1].ask_close,
                source=members[0].source,
                price_kind=members[0].price_kind,
            )
        )
    return out
