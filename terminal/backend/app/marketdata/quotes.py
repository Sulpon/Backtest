"""
The one normalized tick shape every streaming provider adapter must
produce - the real-time analogue of models.py's `Candle` for the historical
REST path. `MarketQuote` and `Candle` are deliberately separate models (not
one shared base): a tick has no OHLC, a candle has no single bid/ask - and
`MarketQuote` is never persisted to DuckDB (see stream_service.py's module
docstring), so it never needs the `instrument_id`/DB-row shape `Candle` has.

TickNormalizer mirrors the Provider -> Adapter -> Normalization split
`fxcm.py`'s own `_row_to_candle` already established for candles: a
provider's raw wire format is parsed into `MarketQuote` in one place per
provider, so nothing downstream (CandleAggregator, MarketDataStreamService,
the WebSocket route) ever has to know a provider-specific tick shape.
"""
from __future__ import annotations

from pydantic import BaseModel, computed_field, field_validator


class MarketQuote(BaseModel):
    """One real-time bid/ask tick. `mid`/`spread` are `@computed_field`
    properties, not plain fields - structurally guaranteeing they can never
    be independently supplied or rounded, only ever derived from the exact
    `bid`/`ask` a provider sent. Rejects `bid<=0`/`ask<=0` (garbage/parsing
    failure) but deliberately does NOT reject a momentarily-crossed book
    (`bid > ask`) - real feeds do this during fast-moving conditions, and
    silently rejecting it would be exactly the kind of fabrication-by-
    omission `docs/ARCHITECTURE.md`'s market-data rules forbid."""

    symbol: str  # canonical symbol, e.g. "EURUSD" - never a provider symbol
    timestamp_ms: int  # unix milliseconds - ticks need sub-second resolution, unlike Candle's unix-second timestamps
    bid: float
    ask: float
    source: str  # provider name (e.g. "fxcm", "mock_stream")

    @field_validator("bid", "ask")
    @classmethod
    def _must_be_positive(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("bid/ask must be > 0")
        return value

    @computed_field  # type: ignore[prop-decorator]
    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2

    @computed_field  # type: ignore[prop-decorator]
    @property
    def spread(self) -> float:
        return self.ask - self.bid


class TickNormalizer:
    """Provider-specific raw tick -> MarketQuote. Stateless (all methods are
    staticmethods) - one method per provider's raw wire format, same
    one-function-per-shape approach as fxcm.py's `_row_to_candle`."""

    @staticmethod
    def from_fxcm(raw: dict) -> "MarketQuote":
        """Parses FXCM's assumed Socket.IO price-update payload shape - see
        providers/fxcm.py's `stream_prices()` docstring for the caveats
        around this being unverified against a live connection. Imported
        here (not fxcm.py) so a future second FXCM-shaped feed (or a test)
        can reuse this parsing without importing the provider adapter
        itself."""
        from .symbols import from_fxcm_symbol  # local import: avoids a hard dependency for callers that only need MarketQuote/from_mock

        provider_symbol = raw["Symbol"]
        rates = raw["Rates"]
        bid, ask = float(rates[0]), float(rates[1])
        return MarketQuote(
            symbol=from_fxcm_symbol(provider_symbol),
            timestamp_ms=int(raw["Updated"]),
            bid=bid,
            ask=ask,
            source="fxcm",
        )

    @staticmethod
    def from_mock(symbol: str, bid: float, ask: float, timestamp_ms: int) -> "MarketQuote":
        """MockStreamProvider's own synthetic ticks are already
        canonically-symbol'd and don't need any wire-format parsing - this
        exists purely so MockStreamProvider goes through the same
        normalization seam every other provider does, rather than
        constructing `MarketQuote` directly."""
        return MarketQuote(symbol=symbol, timestamp_ms=timestamp_ms, bid=bid, ask=ask, source="mock_stream")
