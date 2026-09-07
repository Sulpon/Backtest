"""
Dukascopy's bi5 tick records store prices as raw integers - the real price
is `raw_value / point_value`. Point value is 100000 for standard pairs and
1000 for JPY-quoted pairs and metals.

Metals EMPIRICALLY VERIFIED 2026-08-31 against real downloaded samples
(XAUUSD 2026-07-26 12:00 UTC hour, XAGUSD same hour): dividing raw prices
by 1000 gave ~$4625/oz gold and ~$68.66/oz silver (both plausible for
2026's price environment); dividing by 100000 gave ~$46/oz and ~$0.69/oz
(both implausible - too low by roughly two orders of magnitude for either
metal). 1000 is confirmed correct, not a hypothesis.
"""
from __future__ import annotations

from app.marketdata.symbols import parse_symbol

STANDARD_POINT_VALUE = 100000.0
JPY_POINT_VALUE = 1000.0

# Metals: verified, see this module's docstring above.
_METAL_POINT_VALUES: dict[str, float] = {
    "XAUUSD": 1000.0,
    "XAGUSD": 1000.0,
}


def point_value(symbol: str) -> float:
    """Raw bi5 integer price / this value = the real price. Reuses
    app/marketdata/symbols.py's parse_symbol() rather than maintaining a
    second JPY-pair list - `parts.quote == "JPY"` is exactly the same
    condition that already governs OANDA/FXCM symbol handling elsewhere in
    this codebase."""
    if symbol in _METAL_POINT_VALUES:
        return _METAL_POINT_VALUES[symbol]
    parts = parse_symbol(symbol)
    return JPY_POINT_VALUE if parts.quote == "JPY" else STANDARD_POINT_VALUE
