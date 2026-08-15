"""
The one normalized candle shape every provider adapter must produce, and
the only shape the rest of the app (database, service, aggregation, API)
ever sees - the "Normalization" step in Provider -> Adapter -> Normalization
-> Validation -> Database -> Repository -> Replay Engine -> Frontend.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, model_validator


class PriceKind(str, Enum):
    """Whether a candle's bid_*/ask_* fields are real provider quotes or
    simply absent - set explicitly rather than inferred, per "do not
    fabricate bid/ask data": a MID_ONLY candle's bid_*/ask_* fields are
    always None, never backfilled from mid."""

    MID = "mid"
    BID_ASK = "bid_ask"  # mid AND bid/ask all populated


class Candle(BaseModel):
    instrument_id: str  # canonical symbol, e.g. "EURUSD" - never a provider symbol
    timeframe: str
    timestamp_utc: int  # unix seconds, candle OPEN time
    open: float
    high: float
    low: float
    close: float
    # Tick/update count within the candle - forex is OTC with no consolidated
    # tape, so no provider can give "real" traded volume the way an exchange
    # can. Never relabelled as real volume anywhere downstream.
    volume: Optional[int] = None
    bid_open: Optional[float] = None
    bid_high: Optional[float] = None
    bid_low: Optional[float] = None
    bid_close: Optional[float] = None
    ask_open: Optional[float] = None
    ask_high: Optional[float] = None
    ask_low: Optional[float] = None
    ask_close: Optional[float] = None
    source: str = "unknown"  # provider name (e.g. "oanda") or "csv_import"
    price_kind: PriceKind = PriceKind.MID

    @model_validator(mode="after")
    def _bid_ask_all_or_nothing(self) -> "Candle":
        # A partial quad (e.g. bid_open set but bid_close missing) is worse
        # than useless - a chart can't render half a candle - so this is a
        # modeling invariant, not a business rule that could have exceptions.
        bid_fields = (self.bid_open, self.bid_high, self.bid_low, self.bid_close)
        if any(f is not None for f in bid_fields) and not all(f is not None for f in bid_fields):
            raise ValueError("bid_open/high/low/close must be all-set or all-None")
        ask_fields = (self.ask_open, self.ask_high, self.ask_low, self.ask_close)
        if any(f is not None for f in ask_fields) and not all(f is not None for f in ask_fields):
            raise ValueError("ask_open/high/low/close must be all-set or all-None")
        return self
