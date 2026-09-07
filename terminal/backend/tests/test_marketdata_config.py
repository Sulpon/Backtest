"""
get_provider()'s MARKET_DATA_PROVIDER resolution - focused on the new
`mock_stream` branch (config.py's whole point is "swapping
MARKET_DATA_PROVIDER is the only code-free way to change which broker
backs the application"). get_provider() is @lru_cache'd, so every test
here clears that cache first to avoid leaking a provider instance across
tests/monkeypatched env vars.
"""
import pytest

from app.marketdata import config
from app.marketdata.providers.mock_stream import MockStreamProvider


@pytest.fixture(autouse=True)
def _clear_provider_cache():
    config.get_provider.cache_clear()
    yield
    config.get_provider.cache_clear()


def test_mock_stream_resolves_with_no_credentials_needed(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "mock_stream")
    monkeypatch.delenv("FXCM_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("OANDA_API_KEY", raising=False)

    provider = config.get_provider()

    assert isinstance(provider, MockStreamProvider)
    assert provider.name == "mock_stream"


def test_unknown_provider_name_raises_config_error_mentioning_mock_stream(monkeypatch):
    monkeypatch.setenv("MARKET_DATA_PROVIDER", "not_a_real_provider")

    with pytest.raises(config.MarketDataConfigError) as excinfo:
        config.get_provider()

    assert "mock_stream" in str(excinfo.value)
