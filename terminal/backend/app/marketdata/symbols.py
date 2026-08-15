"""
Canonical symbol <-> provider symbol mapping - the only place that
translates between "EURUSD" (what the UI/database/replay engine always use)
and a specific provider's own naming ("EUR_USD" for OANDA). Other instrument
metadata (pip size, display precision, margin rate, ...) is deliberately
NOT hardcoded here - it comes from the provider's own instruments endpoint
at sync time and is stored in the `instruments` table, since hardcoding it
would drift from whatever the broker actually quotes (see the architecture
note: "Do NOT hard-code forex assumptions into the database model").
"""
from __future__ import annotations

from dataclasses import dataclass

MAJOR_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD"]

CROSS_PAIRS = [
    "EURGBP", "EURJPY", "EURCHF", "EURAUD", "EURCAD", "EURNZD",
    "GBPJPY", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD",
    "AUDJPY", "AUDNZD", "AUDCAD", "AUDCHF",
    "NZDJPY", "NZDCAD", "NZDCHF",
    "CADJPY", "CADCHF",
    "CHFJPY",
]

FOREX_PAIRS = MAJOR_PAIRS + CROSS_PAIRS  # 28 total
METAL_PAIRS = ["XAUUSD", "XAGUSD"]

SUPPORTED_SYMBOLS = FOREX_PAIRS + METAL_PAIRS


@dataclass(frozen=True)
class SymbolParts:
    base: str
    quote: str
    asset_class: str  # "forex" | "metal"


def parse_symbol(symbol: str) -> SymbolParts:
    if symbol not in SUPPORTED_SYMBOLS:
        raise ValueError(f"Unsupported symbol '{symbol}' - not in the 28 FX pairs + XAU/XAG this app supports")
    base, quote = symbol[:3], symbol[3:]
    asset_class = "metal" if symbol in METAL_PAIRS else "forex"
    return SymbolParts(base=base, quote=quote, asset_class=asset_class)


def to_oanda_symbol(symbol: str) -> str:
    """EURUSD -> EUR_USD. OANDA's own naming is just BASE_QUOTE with an
    underscore, including for metals (XAU_USD)."""
    parts = parse_symbol(symbol)
    return f"{parts.base}_{parts.quote}"


def from_oanda_symbol(provider_symbol: str) -> str:
    return provider_symbol.replace("_", "")


def to_fxcm_symbol(symbol: str) -> str:
    """EURUSD -> EUR/USD. FXCM's own naming is BASE/QUOTE with a forward
    slash, including for metals (XAU/USD) - confirmed against FXCM's own
    help-center URLs for gold/silver, which follow the same convention."""
    parts = parse_symbol(symbol)
    return f"{parts.base}/{parts.quote}"


def from_fxcm_symbol(provider_symbol: str) -> str:
    return provider_symbol.replace("/", "")
