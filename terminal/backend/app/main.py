from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .db import get_connection

app = FastAPI(title="Terminal Data API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

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

    return {
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
