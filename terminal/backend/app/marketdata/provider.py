"""
The seam the rest of the application depends on:

    MarketDataService -> MarketDataProvider -> OANDA / FOREX.com / FXCM

No code outside app/marketdata/providers/ should ever import a concrete
provider directly - MarketDataService (service.py) and everything above it
only ever see this abstract interface.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from .models import Candle


@dataclass(frozen=True)
class ProviderInstrument:
    """One instrument as the provider itself describes it - raw metadata
    used to populate the `instruments` table. Never asserted/hardcoded by
    this app; always what the provider's own instrument-list call returns
    right now."""

    provider_symbol: str
    symbol: str  # canonical, already mapped (e.g. "EURUSD")
    display_precision: int
    pip_location: int  # provider's convention: pip_size = 10 ** pip_location
    minimum_trade_size: Optional[float]
    margin_rate: Optional[float]


class MarketDataProvider(ABC):
    name: str

    @abstractmethod
    def list_instruments(self) -> list[ProviderInstrument]:
        """Which of our supported symbols this provider actually offers
        right now, with their real metadata - queried live, never assumed."""

    @abstractmethod
    def get_candles(self, symbol: str, timeframe: str, start: int, end: int) -> list[Candle]:
        """Historical candles for [start, end) unix seconds, normalized to
        the internal Candle model. `timeframe` must be a granularity this
        provider natively supports - this method knows nothing about
        aggregation; MarketDataService only ever asks for BASE_TIMEFRAME
        and derives the rest."""

    def stream_prices(self, symbols: list[str]):
        """Real-time price stream (architecture doc's Milestone 7). Not
        every provider needs this on day one - the default raises so a
        missing implementation fails loudly instead of silently no-op'ing."""
        raise NotImplementedError(f"{self.name} does not implement streaming yet")
