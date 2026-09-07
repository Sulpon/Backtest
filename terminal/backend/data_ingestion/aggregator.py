"""
Ticks aren't candles yet - this is the one place that buckets raw ticks
into BASE_TIMEFRAME (1m) candles. Every higher timeframe is then produced
by app/marketdata/timeframes.py's EXISTING aggregate_candles(), never
reimplemented here - reusing it guarantees this pipeline's higher-timeframe
bars are bucketed identically to any other candle-to-candle rollup already
in the codebase.
"""
from __future__ import annotations

from app.marketdata.models import Candle, PriceKind
from app.marketdata.timeframes import BASE_TIMEFRAME, aggregate_candles, bucket_start

from .fetcher import RawTick


def ticks_to_1m_candles(ticks: list[RawTick], symbol: str, source: str = "dukascopy") -> list[Candle]:
    """Buckets ticks (already chronologically ordered - fetcher.py's own
    parse order) into 1-minute candles built from MID price, with the real
    bid/ask quad preserved alongside. `volume` = tick count within the
    minute, matching Candle.volume's documented "tick/update count"
    semantic (forex is OTC - no provider, including this one, can offer
    real traded volume)."""
    buckets: dict[int, list[RawTick]] = {}
    order: list[int] = []
    for t in ticks:
        b = bucket_start(t.timestamp_utc, BASE_TIMEFRAME)
        if b not in buckets:
            buckets[b] = []
            order.append(b)
        buckets[b].append(t)

    out: list[Candle] = []
    for b in order:
        members = buckets[b]
        bids = [m.bid for m in members]
        asks = [m.ask for m in members]
        mids = [(m.bid + m.ask) / 2 for m in members]
        out.append(
            Candle(
                instrument_id=symbol,
                timeframe=BASE_TIMEFRAME,
                timestamp_utc=b,
                open=mids[0],
                high=max(mids),
                low=min(mids),
                close=mids[-1],
                volume=len(members),
                bid_open=bids[0],
                bid_high=max(bids),
                bid_low=min(bids),
                bid_close=bids[-1],
                ask_open=asks[0],
                ask_high=max(asks),
                ask_low=min(asks),
                ask_close=asks[-1],
                source=source,
                price_kind=PriceKind.BID_ASK,
            )
        )
    return out


def aggregate_to_timeframes(base_1m: list[Candle], target_timeframes: list[str]) -> dict[str, list[Candle]]:
    """base_1m must already be sorted ascending by timestamp (ticks_to_1m_candles
    preserves this)."""
    return {tf: (base_1m if tf == BASE_TIMEFRAME else aggregate_candles(base_1m, tf)) for tf in target_timeframes}
