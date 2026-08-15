"""
OANDA v20 REST API adapter (https://developer.oanda.com/rest-live-v20/).
Chosen as the primary provider over FOREX.com and FXCM - see the comparison
in the PR/commit description for the full reasoning; in short: broadest
geographic account eligibility, a genuinely free self-serve practice
account with an immediately-generated token, the richest published API
(OANDA publishes its own OpenAPI spec at github.com/oanda/v20-openapi),
native bid/ask candles, and every granularity this app needs.

Verified against that OpenAPI spec and developer.oanda.com directly, not
guessed:
- granularities: S5/S10/S15/S30, M1/M2/M4/M5/M10/M15/M30,
  H1/H2/H3/H4/H6/H8/H12, D/W/M
- `price` query param: any combination of M (mid) / B (bid) / A (ask) -
  this adapter always requests "MBA" so OHLC (from mid) and bid/ask are
  both available in one call, at no extra cost
- max `count` per request: 5000 candles
- `volume` is the number of price updates within the candle, NOT true
  traded volume - forex is OTC with no consolidated tape, so no provider
  can offer that. Never relabelled as real volume.
- REST rate limit: 120 requests/second per IP (HTTP 429 above that)
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from ..config import OandaConfig
from ..models import Candle, PriceKind
from ..provider import MarketDataProvider, ProviderInstrument
from ..symbols import SUPPORTED_SYMBOLS, from_oanda_symbol, to_oanda_symbol

# MarketDataService only ever asks for BASE_TIMEFRAME ("1m") today, but the
# mapping is complete so fetching a higher granularity natively (an
# optimization, not a correctness requirement) doesn't need new code later.
_TIMEFRAME_TO_GRANULARITY = {
    "1m": "M1",
    "5m": "M5",
    "15m": "M15",
    "30m": "M30",
    "1h": "H1",
    "2h": "H2",
    "4h": "H4",
    "6h": "H6",
    "8h": "H8",
    "12h": "H12",
    "1d": "D",
    "1w": "W",
    "1mo": "M",
}

MAX_CANDLES_PER_REQUEST = 5000


class OandaProvider(MarketDataProvider):
    name = "oanda"

    def __init__(self, config: OandaConfig, client: httpx.Client | None = None):
        self._config = config
        self._client = client or httpx.Client(
            base_url=config.rest_base_url,
            headers={"Authorization": f"Bearer {config.api_key}"},
            timeout=30.0,
        )

    def list_instruments(self) -> list[ProviderInstrument]:
        resp = self._client.get(f"/v3/accounts/{self._config.account_id}/instruments")
        resp.raise_for_status()
        out: list[ProviderInstrument] = []
        for row in resp.json().get("instruments", []):
            provider_symbol = row["name"]
            symbol = from_oanda_symbol(provider_symbol)
            if symbol not in SUPPORTED_SYMBOLS:
                continue  # OANDA lists far more than forex+metals (indices, bonds, ...) - not our concern
            out.append(
                ProviderInstrument(
                    provider_symbol=provider_symbol,
                    symbol=symbol,
                    display_precision=row.get("displayPrecision", 5),
                    pip_location=row.get("pipLocation", -4),
                    minimum_trade_size=float(row["minimumTradeSize"]) if row.get("minimumTradeSize") else None,
                    margin_rate=float(row["marginRate"]) if row.get("marginRate") else None,
                )
            )
        return out

    def get_candles(self, symbol: str, timeframe: str, start: int, end: int) -> list[Candle]:
        granularity = _TIMEFRAME_TO_GRANULARITY.get(timeframe)
        if granularity is None:
            raise ValueError(f"OANDA has no native granularity for timeframe '{timeframe}'")
        provider_symbol = to_oanda_symbol(symbol)

        candles: list[Candle] = []
        cursor = start
        while cursor < end:
            resp = self._client.get(
                f"/v3/instruments/{provider_symbol}/candles",
                params={
                    "granularity": granularity,
                    "price": "MBA",
                    "from": _to_iso(cursor),
                    "to": _to_iso(end),
                    "count": MAX_CANDLES_PER_REQUEST,
                },
            )
            resp.raise_for_status()
            rows = resp.json().get("candles", [])
            if not rows:
                break
            for row in rows:
                if not row.get("complete", True):
                    continue  # the still-forming current candle - not historical yet
                candles.append(_row_to_candle(row, symbol, timeframe))
            last_ts = _from_iso(rows[-1]["time"])
            if last_ts <= cursor:
                break  # safety valve against an infinite loop on a malformed/empty-progress response
            cursor = last_ts + 1
            if len(rows) < MAX_CANDLES_PER_REQUEST:
                break
        return candles


def _to_iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _from_iso(s: str) -> int:
    # OANDA timestamps carry fractional seconds ("...123456789Z") - the
    # internal Candle model only stores whole unix seconds.
    head = s.split(".")[0]
    return int(datetime.strptime(head, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())


def _row_to_candle(row: dict, symbol: str, timeframe: str) -> Candle:
    mid = row["mid"]
    bid = row.get("bid")
    ask = row.get("ask")
    has_bid_ask = bid is not None and ask is not None
    return Candle(
        instrument_id=symbol,
        timeframe=timeframe,
        timestamp_utc=_from_iso(row["time"]),
        open=float(mid["o"]),
        high=float(mid["h"]),
        low=float(mid["l"]),
        close=float(mid["c"]),
        volume=row.get("volume"),
        bid_open=float(bid["o"]) if bid else None,
        bid_high=float(bid["h"]) if bid else None,
        bid_low=float(bid["l"]) if bid else None,
        bid_close=float(bid["c"]) if bid else None,
        ask_open=float(ask["o"]) if ask else None,
        ask_high=float(ask["h"]) if ask else None,
        ask_low=float(ask["l"]) if ask else None,
        ask_close=float(ask["c"]) if ask else None,
        source="oanda",
        price_kind=PriceKind.BID_ASK if has_bid_ask else PriceKind.MID,
    )
