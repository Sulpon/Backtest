import os
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .db import get_connection

app = FastAPI(title="Terminal Data API", version="0.1.0")

# Comma-separated list, e.g. "https://your-frontend.vercel.app,https://your-app.example.com".
# Defaults to exactly the two origins this API has always allowed (Vite's
# dev server) so local development is unaffected when the env var is unset -
# only set CORS_ALLOWED_ORIGINS to change this, e.g. for a production
# deployment where the frontend is on a different origin than the backend
# (same-origin deployments, such as one Vercel project routing /api/* to
# this service, don't need CORS at all - the browser never cross-origins).
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
# `or` (not `os.environ.get`'s default arg) so a present-but-blank
# CORS_ALLOWED_ORIGINS= (e.g. copied straight from .env.example) still
# falls back to the default instead of silently allowing zero origins.
allowed_origins = [o.strip() for o in (os.environ.get("CORS_ALLOWED_ORIGINS") or _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET"],
    allow_headers=["*"],
)
# /api/dataset responses run 5-11MB uncompressed (100k candles + tens of
# thousands of SMC events) - gzip gets that down ~6x. A no-op in production
# specifically on Vercel, which already Brotli-compresses at the edge
# regardless of this middleware, but local dev (and any non-Vercel host)
# had no compression at all before this.
app.add_middleware(GZipMiddleware, minimum_size=1000)

Timeframe = Literal["1m", "5m", "15m", "30m", "1h", "4h", "1d"]


class SymbolInfo(BaseModel):
    symbol: str
    label: str


class CandleBar(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class SwingPoint(BaseModel):
    bar: int
    price: float
    type: str
    kind: Literal["high", "low"]


class BosEvent(BaseModel):
    barStart: int
    barEnd: int
    price: float
    direction: Literal["bull", "bear"]
    kind: Literal["bos", "choch"]


class FvgEvent(BaseModel):
    bar: int
    top: float
    bottom: float
    direction: Literal["bull", "bear"]


class OrderBlock(BaseModel):
    bar: int
    barEnd: int
    top: float
    bottom: float
    direction: Literal["bull", "bear"]


class VolumeImbalanceEvent(BaseModel):
    bar: int
    top: float
    bottom: float
    direction: Literal["bull", "bear"]


class LiquidityEvent(BaseModel):
    barStart: int
    barEnd: int
    price: float
    direction: Literal["sell_side", "buy_side"]


class Trade(BaseModel):
    dir: Literal["long", "short"]
    entryBar: int
    entryPrice: float
    sl: float
    tp: float
    exitBar: int
    result: Literal["Win", "Lose"]
    r: float
    setup: str


class SetupStat(BaseModel):
    n: int
    wr: float
    exp: float


class Stats(BaseModel):
    total: int
    wins: int
    losses: int
    winRate: float
    expectancy: float
    rr: float
    breakevenWr: float
    bySetup: dict[str, SetupStat]


class SymbolTimeframeData(BaseModel):
    symbol: str
    timeframe: Timeframe
    bars: list[CandleBar]
    swingPoints: list[SwingPoint]
    bosEvents: list[BosEvent]
    fvgEvents: list[FvgEvent]
    orderBlocks: list[OrderBlock]
    volumeImbalanceEvents: list[VolumeImbalanceEvent]
    liquidityEvents: list[LiquidityEvent]
    trades: list[Trade]
    stats: Optional[Stats]


@app.get("/api/symbols", response_model=list[SymbolInfo])
def list_symbols():
    con = get_connection()
    rows = con.execute("SELECT symbol, label FROM symbols ORDER BY symbol").fetchall()
    return [{"symbol": r[0], "label": r[1]} for r in rows]


class Quote(BaseModel):
    symbol: str
    last: Optional[float]
    prev: Optional[float]


@app.get("/api/quotes", response_model=list[Quote])
def get_quotes(timeframe: Timeframe = Query("1h")):
    """Last/previous close per symbol for the watchlist - deliberately NOT
    /api/dataset, which returns the full candle + SMC event history (5-11MB
    per symbol). The watchlist only ever displays two numbers per row, so it
    doesn't need bars, swings, BOS/CHoCH, FVG, order blocks, or trades."""
    con = get_connection()
    ranked = con.execute(
        "SELECT symbol, close FROM ("
        "  SELECT symbol, close, "
        "    row_number() OVER (PARTITION BY symbol ORDER BY bar_index DESC) AS rn "
        "  FROM candles WHERE timeframe = ?"
        ") WHERE rn <= 2",
        [timeframe],
    ).fetchall()
    by_symbol: dict[str, list[float]] = {}
    for sym, close in ranked:
        by_symbol.setdefault(sym, []).append(close)

    symbol_rows = con.execute("SELECT symbol FROM symbols ORDER BY symbol").fetchall()
    result = []
    for (symbol,) in symbol_rows:
        closes = by_symbol.get(symbol, [])
        result.append({
            "symbol": symbol,
            "last": closes[0] if len(closes) > 0 else None,
            "prev": closes[1] if len(closes) > 1 else None,
        })
    return result


@app.get("/api/dataset", response_model=SymbolTimeframeData)
def get_dataset(symbol: str = Query(...), timeframe: Timeframe = Query(...)):
    con = get_connection()

    exists = con.execute("SELECT 1 FROM symbols WHERE symbol = ?", [symbol]).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Unknown symbol '{symbol}'")

    bars = con.execute(
        "SELECT time, open, high, low, close FROM candles "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_index",
        [symbol, timeframe],
    ).fetchall()

    swings = con.execute(
        "SELECT bar_index, price, type, kind FROM swing_points "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_index",
        [symbol, timeframe],
    ).fetchall()

    bos = con.execute(
        "SELECT bar_start, bar_end, price, direction, kind FROM bos_events "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_end",
        [symbol, timeframe],
    ).fetchall()

    fvg = con.execute(
        "SELECT bar_index, top, bottom, direction FROM fvg_events "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_index",
        [symbol, timeframe],
    ).fetchall()

    volume_imbalance = con.execute(
        "SELECT bar_index, top, bottom, direction FROM volume_imbalance_events "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_index",
        [symbol, timeframe],
    ).fetchall()

    liquidity = con.execute(
        "SELECT bar_start, bar_end, price, direction FROM liquidity_events "
        "WHERE symbol = ? AND timeframe = ? ORDER BY bar_end",
        [symbol, timeframe],
    ).fetchall()

    # order blocks + trades/stats only exist for EURUSD 1h - they come from
    # the full backtest engine (fib-OTE entry/SL/TP, daily-bias A/B/C/D
    # tagging), which has only ever been validated for that one combo. Every
    # other symbol/timeframe gets real structure (candles/swings/BOS/FVG/
    # volume-imbalance/liquidity) but no fabricated trade history.
    order_blocks = []
    if symbol == "EURUSD" and timeframe == "1h":
        order_blocks = con.execute(
            "SELECT bar_index, bar_end, top, bottom, direction FROM order_blocks WHERE symbol = ? ORDER BY bar_index",
            [symbol],
        ).fetchall()

    trades = []
    stats = None
    if symbol == "EURUSD" and timeframe == "1h":
        trades = con.execute(
            "SELECT dir, entry_bar, entry_price, sl, tp, exit_bar, result, r, setup "
            "FROM trades WHERE symbol = ? ORDER BY entry_bar",
            [symbol],
        ).fetchall()
        stat_row = con.execute(
            "SELECT total, wins, losses, win_rate, expectancy, rr, breakeven_wr, by_setup "
            "FROM stats WHERE symbol = ?",
            [symbol],
        ).fetchone()
        if stat_row:
            import json
            stats = {
                "total": stat_row[0], "wins": stat_row[1], "losses": stat_row[2],
                "winRate": stat_row[3], "expectancy": stat_row[4], "rr": stat_row[5],
                "breakevenWr": stat_row[6], "bySetup": json.loads(stat_row[7]),
            }

    payload = {
        "symbol": symbol,
        "timeframe": timeframe,
        "bars": [{"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4]} for r in bars],
        "swingPoints": [{"bar": r[0], "price": r[1], "type": r[2], "kind": r[3]} for r in swings],
        "bosEvents": [{"barStart": r[0], "barEnd": r[1], "price": r[2], "direction": r[3], "kind": r[4]} for r in bos],
        "fvgEvents": [{"bar": r[0], "top": r[1], "bottom": r[2], "direction": r[3]} for r in fvg],
        "orderBlocks": [{"bar": r[0], "barEnd": r[1], "top": r[2], "bottom": r[3], "direction": r[4]} for r in order_blocks],
        "volumeImbalanceEvents": [{"bar": r[0], "top": r[1], "bottom": r[2], "direction": r[3]} for r in volume_imbalance],
        "liquidityEvents": [{"barStart": r[0], "barEnd": r[1], "price": r[2], "direction": r[3]} for r in liquidity],
        "trades": [
            {"dir": r[0], "entryBar": r[1], "entryPrice": r[2], "sl": r[3], "tp": r[4],
             "exitBar": r[5], "result": r[6], "r": r[7], "setup": r[8]}
            for r in trades
        ],
        "stats": stats,
    }
    # Returning a Response directly makes FastAPI skip response_model
    # validation/jsonable_encoder on the way out - measured at ~350-420ms of
    # pure overhead for this endpoint's ~140k-item payload (re-walking
    # every bar/event through Pydantic a second time), on top of the
    # ~130-150ms actually spent querying DuckDB and building the dict
    # above. The data going out here is our own DB's output, not
    # unvalidated user input, so there's no correctness reason to pay for
    # that second validation pass. response_model stays on the decorator
    # purely so /docs still shows the real response schema.
    return JSONResponse(content=payload)
