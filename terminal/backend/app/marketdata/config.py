"""
Provider configuration, read from the environment (.env, loaded via
python-dotenv - see terminal/backend/.env.example). Swapping
MARKET_DATA_PROVIDER is meant to be the only code-free way to change which
broker backs the application; nothing outside this module should read a
provider-specific env var directly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

# Guarded exactly like main.py's own load_dotenv() call: python-dotenv is a
# requirements-dev.txt-only dependency (see that file's comment on this
# import), so its absence in production (Vercel installs requirements.txt
# only) must stay a no-op, not a module-level ImportError that takes down
# every route importing this module - confirmed the hard way via a real
# FUNCTION_INVOCATION_FAILED in production before this guard existed.
try:
    from dotenv import load_dotenv

    load_dotenv()  # no-op if .env doesn't exist - env vars set another way still work
except ImportError:
    pass


class MarketDataConfigError(RuntimeError):
    """Raised when the selected provider is missing required configuration -
    caught at the call site to surface a clear setup instruction instead of
    a raw KeyError from deep inside a provider."""


@dataclass(frozen=True)
class OandaConfig:
    api_key: str
    account_id: str
    environment: str  # "practice" | "live"

    @property
    def rest_base_url(self) -> str:
        return "https://api-fxpractice.oanda.com" if self.environment == "practice" else "https://api-fxtrade.oanda.com"

    @property
    def stream_base_url(self) -> str:
        return "https://stream-fxpractice.oanda.com" if self.environment == "practice" else "https://stream-fxtrade.oanda.com"


@dataclass(frozen=True)
class FxcmConfig:
    access_token: str
    environment: str  # "demo" | "real"

    @property
    def rest_base_url(self) -> str:
        return "https://api-demo.fxcm.com" if self.environment == "demo" else "https://api.fxcm.com"


def get_provider_name() -> str:
    return os.environ.get("MARKET_DATA_PROVIDER", "oanda").strip().lower()


def get_fxcm_config() -> FxcmConfig:
    access_token = os.environ.get("FXCM_ACCESS_TOKEN", "").strip()
    environment = os.environ.get("FXCM_ENVIRONMENT", "demo").strip().lower()
    if not access_token:
        raise MarketDataConfigError(
            "FXCM_ACCESS_TOKEN must be set - copy terminal/backend/.env.example to .env and fill it in. "
            "Generate a token by logging in to Trading Station Web (https://tradingstation.fxcm.com) with "
            "a demo account - note FXCM does not accept US residents at all, not even for demo accounts."
        )
    if environment not in ("demo", "real"):
        raise MarketDataConfigError(f"FXCM_ENVIRONMENT must be 'demo' or 'real', got '{environment}'")
    return FxcmConfig(access_token=access_token, environment=environment)


def get_oanda_config() -> OandaConfig:
    api_key = os.environ.get("OANDA_API_KEY", "").strip()
    account_id = os.environ.get("OANDA_ACCOUNT_ID", "").strip()
    environment = os.environ.get("OANDA_ENVIRONMENT", "practice").strip().lower()
    if not api_key or not account_id:
        raise MarketDataConfigError(
            "OANDA_API_KEY and OANDA_ACCOUNT_ID must be set - copy terminal/backend/.env.example to "
            ".env and fill them in (a free practice account is enough; see the comments in that file "
            "for exactly where to generate a token)."
        )
    if environment not in ("practice", "live"):
        raise MarketDataConfigError(f"OANDA_ENVIRONMENT must be 'practice' or 'live', got '{environment}'")
    return OandaConfig(api_key=api_key, account_id=account_id, environment=environment)


@lru_cache(maxsize=1)
def get_provider():
    """Builds the configured MarketDataProvider. Cached because constructing
    one opens an httpx.Client - callers should share this instance rather
    than each making their own."""
    from .provider import MarketDataProvider  # local import: avoids a cycle with providers/*.py

    name = get_provider_name()
    provider: MarketDataProvider
    if name == "oanda":
        from .providers.oanda import OandaProvider

        provider = OandaProvider(get_oanda_config())
    elif name == "fxcm":
        from .providers.fxcm import FxcmProvider

        provider = FxcmProvider(get_fxcm_config())
    else:
        raise MarketDataConfigError(
            f"Unknown MARKET_DATA_PROVIDER '{name}' - 'oanda' or 'fxcm' are implemented so far."
        )
    return provider
