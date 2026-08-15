"""
FXCM REST ("Socket REST") API adapter (https://fxcm-rest.readthedocs.io).

IMPORTANT - read before relying on this in production:
FXCM's own documentation is materially less precise than OANDA's (OANDA
publishes an official machine-readable OpenAPI spec; FXCM's is a
community-maintained readthedocs page built from a wiki). Two things in
particular could not be pinned down with certainty from the docs alone and
are this adapter's most likely source of a real-world 401/403 the first
time it's actually run:
  1. The exact Authorization header format after the socket.io handshake.
     The docs describe it in prose as "'Bearer ' + socket_id api_token" but
     the only literal example shown uses just the access token. This
     adapter implements the literal example (Bearer <access_token>,
     established via the socket.io handshake first) - if that's wrong,
     the fix is isolated to _authenticate() below.
  2. FXCM does not publish REST rate limits anywhere in this documentation
     (OANDA explicitly documents 120 req/s). This adapter does not assume
     a specific number and relies on this app's own conservative,
     sequential (non-parallel) request pattern instead.

Verified from the docs (not guessed):
- auth: GET /socket.io/?access_token=... (polling handshake) -> a socket
  id, then normal HTTPS requests with `Authorization: Bearer <token>`
- instrument discovery: GET /trading/get_model?models=Offer -> the Offers
  table, mapping a symbol string ("EUR/USD") to an integer offerId that
  every other endpoint requires instead of the symbol itself
- historical candles: GET /candles/{offer_id}/{period_id}?num=&from=&to=
  - period_id: m1,m5,m15,m30,H1,H2,H3,H4,H6,H8,D1,W1,M1
  - num: 1-10,000 candles per request
  - response rows are POSITIONAL ARRAYS in this exact order:
    [timestamp, BidOpen, BidClose, BidHigh, BidLow, AskOpen, AskClose,
     AskHigh, AskLow, TickQty] - note Open/Close/High/Low order, NOT the
    usual Open/High/Low/Close.
  - no native mid price is returned, only bid and ask - this adapter
    derives open/high/low/close as the bid/ask midpoint per field, which
    is why every FXCM-sourced candle is price_kind=BID_ASK: the "OHLC"
    values are a derived midpoint, not a third independently-quoted price,
    while bid_*/ask_* are exactly what FXCM returned.
- symbol naming: "EUR/USD" (slash), same convention for metals ("XAU/USD")
- demo base URL: https://api-demo.fxcm.com, live: https://api.fxcm.com
"""
from __future__ import annotations

import httpx

from ..config import FxcmConfig
from ..models import Candle, PriceKind
from ..provider import MarketDataProvider, ProviderInstrument
from ..symbols import SUPPORTED_SYMBOLS, from_fxcm_symbol, to_fxcm_symbol

_TIMEFRAME_TO_PERIOD = {
    "1m": "m1",
    "5m": "m5",
    "15m": "m15",
    "30m": "m30",
    "1h": "H1",
    "2h": "H2",
    "4h": "H4",
    "6h": "H6",
    "8h": "H8",
    "1d": "D1",
    "1w": "W1",
    "1mo": "M1",
}

MAX_CANDLES_PER_REQUEST = 10_000


class FxcmProvider(MarketDataProvider):
    name = "fxcm"

    def __init__(self, config: FxcmConfig, client: httpx.Client | None = None):
        self._config = config
        self._client = client or httpx.Client(base_url=config.rest_base_url, timeout=30.0)
        self._authenticated = False
        self._offer_id_by_symbol: dict[str, int] | None = None

    def _authenticate(self) -> None:
        # Socket.io polling handshake with the access token establishes the
        # session; subsequent plain HTTPS requests carry the same token as
        # a bearer credential. See the module docstring's caveat #1 if this
        # doesn't hold up against a real account.
        resp = self._client.get(
            "/socket.io/", params={"access_token": self._config.access_token, "EIO": 3, "transport": "polling"}
        )
        resp.raise_for_status()
        self._client.headers["Authorization"] = f"Bearer {self._config.access_token}"
        self._authenticated = True

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        if not self._authenticated:
            self._authenticate()
        resp = self._client.request(method, path, **kwargs)
        if resp.status_code in (401, 403) and self._authenticated:
            # Session may have expired - undocumented lifetime, so react to
            # an auth failure rather than guess a refresh interval.
            self._authenticated = False
            self._authenticate()
            resp = self._client.request(method, path, **kwargs)
        resp.raise_for_status()
        return resp

    def _offer_id(self, symbol: str) -> int:
        if self._offer_id_by_symbol is None:
            self._load_offers()
        offer_id = (self._offer_id_by_symbol or {}).get(symbol)
        if offer_id is None:
            raise ValueError(f"FXCM has no offer_id for '{symbol}' - not returned by /trading/get_model")
        return offer_id

    def _load_offers(self) -> None:
        resp = self._request("GET", "/trading/get_model", params={"models": "Offer"})
        offers = resp.json().get("offers", []) or resp.json().get("data", {}).get("offers", [])
        mapping: dict[str, int] = {}
        for row in offers:
            provider_symbol = row.get("currency") or row.get("symbol")
            offer_id = row.get("offerId")
            if provider_symbol is None or offer_id is None:
                continue
            symbol = from_fxcm_symbol(provider_symbol)
            if symbol in SUPPORTED_SYMBOLS:
                mapping[symbol] = int(offer_id)
        self._offer_id_by_symbol = mapping

    def list_instruments(self) -> list[ProviderInstrument]:
        self._load_offers()
        out = []
        for symbol, offer_id in (self._offer_id_by_symbol or {}).items():
            out.append(
                ProviderInstrument(
                    provider_symbol=to_fxcm_symbol(symbol),
                    symbol=symbol,
                    display_precision=5,  # FXCM's Offer table has ratePrecision per-instrument;
                    pip_location=-4,      # not fetched here since sync_instruments' pip_size use is best-effort
                    minimum_trade_size=None,
                    margin_rate=None,
                )
            )
        return out

    def get_candles(self, symbol: str, timeframe: str, start: int, end: int) -> list[Candle]:
        period = _TIMEFRAME_TO_PERIOD.get(timeframe)
        if period is None:
            raise ValueError(f"FXCM has no native period for timeframe '{timeframe}'")
        offer_id = self._offer_id(symbol)

        candles: list[Candle] = []
        cursor = start
        while cursor < end:
            resp = self._request(
                "GET",
                f"/candles/{offer_id}/{period}",
                params={"num": MAX_CANDLES_PER_REQUEST, "from": cursor, "to": end},
            )
            rows = resp.json().get("candles", [])
            if not rows:
                break
            for row in rows:
                ts = int(row[0])
                if ts < start or ts >= end:
                    continue
                candles.append(_row_to_candle(row, symbol, timeframe))
            last_ts = int(rows[-1][0])
            if last_ts <= cursor:
                break  # safety valve against an infinite loop on a malformed/empty-progress response
            cursor = last_ts + 1
            if len(rows) < MAX_CANDLES_PER_REQUEST:
                break
        candles.sort(key=lambda c: c.timestamp_utc)
        return candles


def _row_to_candle(row: list, symbol: str, timeframe: str) -> Candle:
    # [timestamp, BidOpen, BidClose, BidHigh, BidLow, AskOpen, AskClose, AskHigh, AskLow, TickQty]
    ts, bid_o, bid_c, bid_h, bid_l, ask_o, ask_c, ask_h, ask_l, tick_qty = row[:10]
    bid_o, bid_c, bid_h, bid_l = float(bid_o), float(bid_c), float(bid_h), float(bid_l)
    ask_o, ask_c, ask_h, ask_l = float(ask_o), float(ask_c), float(ask_h), float(ask_l)
    return Candle(
        instrument_id=symbol,
        timeframe=timeframe,
        timestamp_utc=int(ts),
        # No native mid from FXCM - the bid/ask midpoint per field, not a
        # third independently-quoted price (see module docstring).
        open=(bid_o + ask_o) / 2,
        high=(bid_h + ask_h) / 2,
        low=(bid_l + ask_l) / 2,
        close=(bid_c + ask_c) / 2,
        volume=int(tick_qty) if tick_qty is not None else None,
        bid_open=bid_o, bid_high=bid_h, bid_low=bid_l, bid_close=bid_c,
        ask_open=ask_o, ask_high=ask_h, ask_low=ask_l, ask_close=ask_c,
        source="fxcm",
        price_kind=PriceKind.BID_ASK,
    )
