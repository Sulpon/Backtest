"""
Deterministic-shape (seeded, bounded random walk) fake tick stream - the
only provider this pass's automated tests and local dev actually run
against live (see market-data-specialist's mock-only verification
decision: the real FxcmProvider.stream_prices() is unverified against a
live connection). Switch to it with `MARKET_DATA_PROVIDER=mock_stream` -
needs zero credentials, matching config.py's other providers' contract of
never requiring a provider-specific env var outside config.py itself.
"""
from __future__ import annotations

import random
import time
from typing import Callable, Iterator

from ..models import Candle
from ..provider import MarketDataProvider, ProviderInstrument
from ..quotes import MarketQuote, TickNormalizer
from ..symbols import SUPPORTED_SYMBOLS

# Small seed-price table covering all 30 SUPPORTED_SYMBOLS - plausible,
# roughly-real-world starting points for the random walk below, not sourced
# from any live feed (this is a mock; nothing here is a real quote).
_SEED_PRICES: dict[str, float] = {
    "EURUSD": 1.0850, "GBPUSD": 1.2650, "USDJPY": 149.50, "USDCHF": 0.8850,
    "USDCAD": 1.3650, "AUDUSD": 0.6550, "NZDUSD": 0.6050,
    "EURGBP": 0.8580, "EURJPY": 162.20, "EURCHF": 0.9600, "EURAUD": 1.6560,
    "EURCAD": 1.4810, "EURNZD": 1.7930,
    "GBPJPY": 189.10, "GBPCHF": 1.1200, "GBPAUD": 1.9310, "GBPCAD": 1.7270,
    "GBPNZD": 2.0910,
    "AUDJPY": 97.90, "AUDNZD": 1.0830, "AUDCAD": 0.8940, "AUDCHF": 0.5800,
    "NZDJPY": 90.40, "NZDCAD": 0.8260, "NZDCHF": 0.5360,
    "CADJPY": 109.60, "CADCHF": 0.6490,
    "CHFJPY": 168.90,
    "XAUUSD": 2350.0, "XAGUSD": 28.0,
}
assert set(_SEED_PRICES) == set(SUPPORTED_SYMBOLS)  # fails loudly at import time if either list ever drifts from the other

_TICK_INTERVAL_SECONDS = 0.5
# Bounded random-walk step, expressed as a fraction of the current mid - a
# small enough fraction that a symbol never wanders into an implausible
# price range over one dev/test session, without needing per-symbol
# pip-size metadata (which a mock deliberately has no access to - only a
# real provider's own instrument endpoint knows that, per symbols.py's own
# module docstring).
_STEP_FRACTION = 0.00005
_SPREAD_FRACTION = 0.0002  # a bounded synthetic spread, never claimed to be a real quoted spread


class MockStreamProvider(MarketDataProvider):
    name = "mock_stream"

    def __init__(self, seed: int | None = None, sleep_fn: Callable[[float], None] = time.sleep):
        # `sleep_fn` is injected purely for testability (test_mock_stream_provider.py
        # passes a no-op so tests never wait a real 0.5s per tick).
        self._rng = random.Random(seed)
        self._sleep = sleep_fn

    def list_instruments(self) -> list[ProviderInstrument]:
        return [
            ProviderInstrument(
                provider_symbol=symbol, symbol=symbol, display_precision=5,
                pip_location=-4, minimum_trade_size=None, margin_rate=None,
            )
            for symbol in SUPPORTED_SYMBOLS
        ]

    def get_candles(self, symbol: str, timeframe: str, start: int, end: int) -> list[Candle]:
        # Streaming-only test/dev provider - deliberately does not fabricate
        # historical REST candles it never actually received. A caller that
        # hits /api/marketdata/candles against mock_stream gets a clear
        # failure (surfaced as the existing 502 path in main.py), not
        # invented data.
        raise NotImplementedError(
            "MockStreamProvider is a streaming-only test/dev provider - it has no historical REST candles"
        )

    def stream_prices(self, symbols: list[str]) -> Iterator[MarketQuote]:
        mids: dict[str, float] = {}
        for symbol in symbols:
            if symbol not in SUPPORTED_SYMBOLS:
                raise ValueError(f"Unsupported symbol '{symbol}'")
            mids[symbol] = _SEED_PRICES[symbol]

        while True:
            for symbol in symbols:
                mid = mids[symbol]
                step = mid * _STEP_FRACTION * self._rng.uniform(-1.0, 1.0)
                mid = max(mid + step, 1e-6)  # never let the walk cross into a non-positive price
                mids[symbol] = mid
                half_spread = mid * _SPREAD_FRACTION / 2
                yield TickNormalizer.from_mock(
                    symbol=symbol,
                    bid=mid - half_spread,
                    ask=mid + half_spread,
                    timestamp_ms=int(time.time() * 1000),
                )
            self._sleep(_TICK_INTERVAL_SECONDS)
