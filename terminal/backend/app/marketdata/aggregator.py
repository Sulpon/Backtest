"""
Turns one symbol's live MarketQuote tick stream into in-progress/confirmed
Candle bars for every LIVE_TIMEFRAMES granularity simultaneously - the
live-path analogue of timeframes.py's aggregate_candles(), which only ever
runs on already-complete historical candles.

Scope boundary (deliberate, not an oversight): candles built here are
MID-only (`price_kind=PriceKind.MID`, `bid_*`/`ask_*` left None). Tracking a
running bid/ask OHLC quad from irregular ticks (four independent high/low
extrema per timeframe, updated once per tick) is real additional complexity
this pass doesn't need - the live chart only ever plots one price line per
candle. If a future pass needs live bid/ask candles, add it as a new,
separately-documented capability here rather than silently upgrading every
existing live candle's price_kind out from under callers that already treat
MID as this module's contract.
"""
from __future__ import annotations

from typing import Optional

from .models import Candle, PriceKind
from .quotes import MarketQuote
from .timeframes import bucket_start, is_valid_timeframe

LIVE_TIMEFRAMES: list[str] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]

assert all(is_valid_timeframe(tf) for tf in LIVE_TIMEFRAMES)  # fails loudly at import time, not at first tick, if this list ever drifts from timeframes.py


def _new_candle(symbol: str, timeframe: str, bucket: int, mid: float, source: str) -> Candle:
    return Candle(
        instrument_id=symbol,
        timeframe=timeframe,
        timestamp_utc=bucket,
        open=mid,
        high=mid,
        low=mid,
        close=mid,
        volume=None,
        source=source,
        price_kind=PriceKind.MID,
    )


class CandleAggregator:
    """One instance per symbol - `MarketDataStreamService` owns exactly one
    of these per subscribed symbol, alongside its per-symbol stream thread."""

    def __init__(self, symbol: str):
        self.symbol = symbol
        self._current: dict[str, Candle] = {}

    def on_quote(self, quote: MarketQuote) -> list[Candle]:
        """Feeds one tick into every LIVE_TIMEFRAMES bucket at once. Returns
        the (usually empty) list of candles that just CONFIRMED (i.e. this
        tick's bucket moved past the previously in-progress one) - the
        caller is responsible for persisting/forwarding those; this class
        holds no history beyond the currently-open bar per timeframe."""
        if quote.symbol != self.symbol:
            raise ValueError(f"CandleAggregator for '{self.symbol}' received a quote for '{quote.symbol}'")

        confirmed: list[Candle] = []
        ts_seconds = quote.timestamp_ms // 1000
        mid = quote.mid

        for tf in LIVE_TIMEFRAMES:
            bucket = bucket_start(ts_seconds, tf)
            existing = self._current.get(tf)

            if existing is None or bucket > existing.timestamp_utc:
                if existing is not None:
                    confirmed.append(existing)
                self._current[tf] = _new_candle(self.symbol, tf, bucket, mid, quote.source)
            elif bucket == existing.timestamp_utc:
                self._current[tf] = existing.model_copy(
                    update={
                        "high": max(existing.high, mid),
                        "low": min(existing.low, mid),
                        "close": mid,
                    }
                )
            # else: bucket < existing.timestamp_utc - a late/out-of-order tick
            # relative to a bucket that's already moved on. Dropped, not
            # applied backwards into an already-superseded bucket - the same
            # "never silently rewrite the past" principle validation.py
            # already applies to the historical path.

        return confirmed

    def current_candle(self, timeframe: str) -> Optional[Candle]:
        """The in-progress (not yet confirmed) bar for `timeframe`, or None
        if no tick has arrived for it yet this session. This is what backs
        the WebSocket's `{"type": "candle", "confirmed": false, ...}`
        messages the frontend's `series.update()` call consumes."""
        return self._current.get(timeframe)
