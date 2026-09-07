"""
MockStreamProvider - the only provider automated tests/local dev actually
stream from live. `sleep_fn` is always a no-op here so nothing in this file
waits a real 0.5s per tick.
"""
import pytest

from app.marketdata.providers.mock_stream import MockStreamProvider
from app.marketdata.symbols import SUPPORTED_SYMBOLS


def _no_sleep(_seconds):
    return None


def test_list_instruments_covers_all_supported_symbols():
    provider = MockStreamProvider()
    symbols = {inst.symbol for inst in provider.list_instruments()}
    assert symbols == set(SUPPORTED_SYMBOLS)


def test_get_candles_raises_not_implemented_rather_than_fabricating_history():
    provider = MockStreamProvider()
    with pytest.raises(NotImplementedError):
        provider.get_candles("EURUSD", "1m", 0, 60)


def test_stream_prices_yields_normalized_quotes_for_requested_symbols():
    provider = MockStreamProvider(seed=1, sleep_fn=_no_sleep)
    gen = provider.stream_prices(["EURUSD", "GBPUSD"])

    first = next(gen)
    second = next(gen)

    assert first.symbol == "EURUSD"
    assert first.source == "mock_stream"
    assert first.bid > 0 and first.ask > 0
    assert second.symbol == "GBPUSD"


def test_stream_prices_walk_stays_bounded_over_many_ticks():
    provider = MockStreamProvider(seed=42, sleep_fn=_no_sleep)
    gen = provider.stream_prices(["EURUSD"])
    seed_mid = None
    last_mid = None
    for _ in range(500):
        q = next(gen)
        if seed_mid is None:
            seed_mid = q.mid
        last_mid = q.mid
    # A 0.005%-per-tick bounded random walk over 500 ticks should never
    # wander anywhere close to doubling/halving the seed price.
    assert 0.5 * seed_mid < last_mid < 1.5 * seed_mid


def test_stream_prices_rejects_unsupported_symbol():
    provider = MockStreamProvider(sleep_fn=_no_sleep)
    gen = provider.stream_prices(["NOPE"])
    with pytest.raises(ValueError):
        next(gen)


def test_stream_prices_is_deterministic_given_the_same_seed():
    a = list(_take(MockStreamProvider(seed=7, sleep_fn=_no_sleep).stream_prices(["EURUSD"]), 5))
    b = list(_take(MockStreamProvider(seed=7, sleep_fn=_no_sleep).stream_prices(["EURUSD"]), 5))
    assert [q.mid for q in a] == [q.mid for q in b]


def _take(gen, n):
    for _ in range(n):
        yield next(gen)
