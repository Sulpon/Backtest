import base64
import binascii
import os
import threading
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .db import get_connection

# Optional local-dev convenience: loads backend/.env into the process
# environment so TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (and anything else
# added to .env.example later) work without exporting real shell env vars.
# Guarded because python-dotenv is a requirements-dev.txt-only dependency
# (see that file) - production (Vercel) sets real env vars directly and
# has never needed this, so its absence there must stay a no-op, not an
# import error that takes down the whole app.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

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
    # POST needed as of the Telegram routes (app/telegram): a POST with a
    # JSON body triggers a real CORS preflight (OPTIONS) request, unlike
    # the GET-only routes above - "GET" alone let the preflight fail
    # silently for any POST call with a Content-Type outside the CORS
    # "simple request" allowlist (e.g. `Content-Type: application/json`),
    # which is exactly what send-trade's JSON body does.
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
# /api/dataset responses run 5-11MB uncompressed (100k candles + tens of
# thousands of SMC events) - gzip gets that down ~6x. A no-op in production
# specifically on Vercel, which already Brotli-compresses at the edge
# regardless of this middleware, but local dev (and any non-Vercel host)
# had no compression at all before this.
#
# compresslevel=4, not the zlib default of 9: measured on a real ~12MB
# dataset payload, level 9 costs ~1200ms of pure CPU for a payload that's
# only 14.8% of raw size, while level 4 costs ~110ms (11x faster) for
# 16.5% of raw - a small compression-ratio difference for an order of
# magnitude less time blocking the request. Levels 5-9 are where the
# time/ratio curve inverts (198ms/6ms/.../1222ms for barely smaller
# output), so 4 is the point past which paying more CPU stops being worth
# it. See terminal/README.md#performance for the full level-by-level
# benchmark this was chosen from.
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=4)

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
def get_dataset(
    symbol: str = Query(...),
    timeframe: Timeframe = Query(...),
    limit: Optional[int] = Query(
        None,
        ge=1,
        description=(
            "Return only the most recent `limit` bars (plus events that fall "
            "entirely within that window), re-indexed so bar 0 of the "
            "response is the first bar returned - not the dataset's true "
            "bar 0. Omit for the full, unwindowed dataset (bar_index "
            "unchanged, exactly as before this parameter existed). Used for "
            "the fast initial paint (see DataLayer.ts); the frontend always "
            "follows up with an unwindowed request for the same symbol/"
            "timeframe to get the complete history every other feature "
            "(replay, Pine indicators, market-structure logging) requires."
        ),
    ),
):
    con = get_connection()

    exists = con.execute("SELECT 1 FROM symbols WHERE symbol = ?", [symbol]).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Unknown symbol '{symbol}'")

    # window_start is the dataset's TRUE bar_index of the first bar this
    # response includes - 0 (i.e. no windowing at all) when `limit` is
    # omitted. Every bar-indexed column below is queried with
    # `bar_index >= window_start` and re-indexed by subtracting it, so the
    # response is always internally self-consistent (bar N in `bars` lines
    # up with event bar-index N) regardless of whether it's windowed.
    if limit is not None:
        total = con.execute(
            "SELECT COUNT(*) FROM candles WHERE symbol = ? AND timeframe = ?", [symbol, timeframe]
        ).fetchone()[0]
        window_start = max(0, total - limit)
    else:
        window_start = 0

    bars = con.execute(
        "SELECT time, open, high, low, close FROM candles "
        "WHERE symbol = ? AND timeframe = ? AND bar_index >= ? ORDER BY bar_index",
        [symbol, timeframe, window_start],
    ).fetchall()

    swings = con.execute(
        "SELECT bar_index, price, type, kind FROM swing_points "
        "WHERE symbol = ? AND timeframe = ? AND bar_index >= ? ORDER BY bar_index",
        [symbol, timeframe, window_start],
    ).fetchall()

    # bar_start/bar_end (and order_blocks'/trades' two-column equivalents)
    # span a range rather than a single bar - only included if the WHOLE
    # span falls inside the window, never clamped/truncated at the edge.
    # A structure that starts before the window simply isn't in this
    # (intentionally partial, fast-paint-only) response; the very next,
    # unwindowed request has it, exactly as today.
    bos = con.execute(
        "SELECT bar_start, bar_end, price, direction, kind FROM bos_events "
        "WHERE symbol = ? AND timeframe = ? AND bar_start >= ? ORDER BY bar_end",
        [symbol, timeframe, window_start],
    ).fetchall()

    fvg = con.execute(
        "SELECT bar_index, top, bottom, direction FROM fvg_events "
        "WHERE symbol = ? AND timeframe = ? AND bar_index >= ? ORDER BY bar_index",
        [symbol, timeframe, window_start],
    ).fetchall()

    volume_imbalance = con.execute(
        "SELECT bar_index, top, bottom, direction FROM volume_imbalance_events "
        "WHERE symbol = ? AND timeframe = ? AND bar_index >= ? ORDER BY bar_index",
        [symbol, timeframe, window_start],
    ).fetchall()

    liquidity = con.execute(
        "SELECT bar_start, bar_end, price, direction FROM liquidity_events "
        "WHERE symbol = ? AND timeframe = ? AND bar_start >= ? ORDER BY bar_end",
        [symbol, timeframe, window_start],
    ).fetchall()

    # order blocks + trades/stats only exist for EURUSD 1h - they come from
    # the full backtest engine (fib-OTE entry/SL/TP, daily-bias A/B/C/D
    # tagging), which has only ever been validated for that one combo. Every
    # other symbol/timeframe gets real structure (candles/swings/BOS/FVG/
    # volume-imbalance/liquidity) but no fabricated trade history.
    order_blocks = []
    if symbol == "EURUSD" and timeframe == "1h":
        order_blocks = con.execute(
            "SELECT bar_index, bar_end, top, bottom, direction FROM order_blocks "
            "WHERE symbol = ? AND bar_index >= ? ORDER BY bar_index",
            [symbol, window_start],
        ).fetchall()

    trades = []
    stats = None
    if symbol == "EURUSD" and timeframe == "1h":
        trades = con.execute(
            "SELECT dir, entry_bar, entry_price, sl, tp, exit_bar, result, r, setup "
            "FROM trades WHERE symbol = ? AND entry_bar >= ? ORDER BY entry_bar",
            [symbol, window_start],
        ).fetchall()
        # Aggregate win-rate/expectancy stats describe the whole backtest,
        # not any one bar range - never windowed, unlike everything above.
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
        "swingPoints": [{"bar": r[0] - window_start, "price": r[1], "type": r[2], "kind": r[3]} for r in swings],
        "bosEvents": [
            {"barStart": r[0] - window_start, "barEnd": r[1] - window_start, "price": r[2], "direction": r[3], "kind": r[4]}
            for r in bos
        ],
        "fvgEvents": [{"bar": r[0] - window_start, "top": r[1], "bottom": r[2], "direction": r[3]} for r in fvg],
        "orderBlocks": [
            {"bar": r[0] - window_start, "barEnd": r[1] - window_start, "top": r[2], "bottom": r[3], "direction": r[4]}
            for r in order_blocks
        ],
        "volumeImbalanceEvents": [
            {"bar": r[0] - window_start, "top": r[1], "bottom": r[2], "direction": r[3]} for r in volume_imbalance
        ],
        "liquidityEvents": [
            {"barStart": r[0] - window_start, "barEnd": r[1] - window_start, "price": r[2], "direction": r[3]}
            for r in liquidity
        ],
        "trades": [
            {"dir": r[0], "entryBar": r[1] - window_start, "entryPrice": r[2], "sl": r[3], "tp": r[4],
             "exitBar": r[5] - window_start, "result": r[6], "r": r[7], "setup": r[8]}
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


# ============================================================================
# TELEGRAM TRADE REVIEW - Milestones 1-2 (connection/config/test message,
# then sending a real existing trade's data). See
# terminal/README.md#telegram-trade-review for the full milestone plan.
# Deliberately local/self-hosted only for now - trade-review answers need
# to persist server-side, and Vercel's serverless filesystem doesn't
# (data.duckdb itself is fetched fresh at BUILD time for exactly this
# reason - see fetch_db.py). Nothing here touches data.duckdb or any
# existing route/table.
# ============================================================================
from .telegram.service import TelegramService  # noqa: E402 - after app setup, matching the rest of this file's route grouping


class TelegramStatus(BaseModel):
    configured: bool


class TelegramTestResult(BaseModel):
    ok: bool
    error: Optional[str] = None


@app.get("/api/telegram/status", response_model=TelegramStatus)
def get_telegram_status():
    return {"configured": TelegramService().configured}


@app.post("/api/telegram/test", response_model=TelegramTestResult)
def post_telegram_test():
    result = TelegramService().send_message(
        "✅ Test message from your backtesting terminal - Telegram is connected."
    )
    return {"ok": result.ok, "error": result.error}


class TradeReviewConditions(BaseModel):
    liquiditySweep: bool = False
    bos: bool = False
    choch: bool = False
    fvg: bool = False


class TradeReviewRequest(BaseModel):
    # tradeId is the frontend's existing symbol:entryBar convention (see
    # journalStore.ts's tradeKey()) - the backend trades table has no
    # primary key of its own (identity is naturally (symbol, entry_bar)),
    # so this reuses that same convention rather than inventing a second
    # one. Every other field is exactly what's already on the frontend's
    # Trade/SymbolTimeframeData objects (see src/data/types.ts) or derived
    # from them client-side (rr, conditions, snapshotDataUrl) - the backend
    # does no lookup or derivation of its own here, only formatting +
    # sending.
    tradeId: str
    symbol: str
    timeframe: str
    direction: Literal["LONG", "SHORT"]
    setup: str
    entry: float
    sl: float
    tp: float
    rr: float
    resultR: float
    closedAt: str
    conditions: TradeReviewConditions
    # Milestone 4 - "data:image/png;base64,...." from ChartPane's own
    # takeSnapshot() (see chartSnapshot.ts), or omitted/None when no
    # matching chart pane was open to capture from. Optional so the
    # Milestone 2 plain-text send path keeps working unchanged.
    snapshotDataUrl: Optional[str] = None


def _decode_snapshot_data_url(data_url: str) -> Optional[bytes]:
    """Fails soft (None, not an exception) on anything malformed - a bad
    snapshot must degrade the send to text-only, never reject the whole
    review (same reasoning as every other Telegram failure mode here)."""
    try:
        _, _, encoded = data_url.partition(",")
        return base64.b64decode(encoded, validate=True) if encoded else None
    except (binascii.Error, ValueError):
        return None


@app.post("/api/telegram/send-trade", response_model=TelegramTestResult)
def post_telegram_send_trade(trade: TradeReviewRequest):
    image_bytes = _decode_snapshot_data_url(trade.snapshotDataUrl) if trade.snapshotDataUrl else None
    payload = trade.model_dump(exclude={"snapshotDataUrl"})
    result = TelegramService().send_trade_review(payload, image_bytes=image_bytes)
    return {"ok": result.ok, "error": result.error}


# ============================================================================
# MARKET DATA PROVIDER SYNC - Roadmap Phase 2. Additive-only: a separate
# route namespace over the existing, previously-disconnected
# app/marketdata/* provider layer (OANDA/FXCM, incremental sync via
# MarketDataService). Reads/writes only market_candles/instruments/
# data_sync_jobs (see marketdata/repository.py) - never the `candles`/
# `symbols` tables build_db.py produces, and never merged into
# /api/dataset's response. See docs/ARCHITECTURE.md's market-data
# source-of-truth rule for the explicit decision this implements: provider
# data is a separate, additive dataset, not a silent replacement.
# ============================================================================
from .marketdata.config import MarketDataConfigError, get_provider, get_provider_name  # noqa: E402
from .marketdata.service import MarketDataService  # noqa: E402
from .marketdata.symbols import SUPPORTED_SYMBOLS  # noqa: E402
from .marketdata.timeframes import is_valid_timeframe  # noqa: E402


class MarketDataStatus(BaseModel):
    provider: str
    configured: bool
    error: Optional[str] = None


@app.get("/api/marketdata/status", response_model=MarketDataStatus)
def get_marketdata_status():
    name = get_provider_name()
    try:
        get_provider()
    except MarketDataConfigError as exc:
        return {"provider": name, "configured": False, "error": str(exc)}
    return {"provider": name, "configured": True, "error": None}


class ProviderCandleBar(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class MarketDataCandlesResponse(BaseModel):
    symbol: str
    timeframe: str
    provider: str
    bars: list[ProviderCandleBar]


@app.get("/api/marketdata/candles", response_model=MarketDataCandlesResponse)
def get_marketdata_candles(
    symbol: str = Query(...),
    timeframe: str = Query(...),
    start: int = Query(..., description="Unix seconds, inclusive"),
    end: int = Query(..., description="Unix seconds, exclusive"),
):
    """Provider-synced OHLC candles - incrementally syncs [start, end) via
    MarketDataService, then returns it. Deliberately separate from
    /api/dataset: no SMC events (the provider layer doesn't compute those),
    no fallback into the static dataset, no writes to its tables."""
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=404, detail=f"Unsupported symbol '{symbol}'")
    if not is_valid_timeframe(timeframe):
        raise HTTPException(status_code=400, detail=f"Unknown timeframe '{timeframe}'")
    if end <= start:
        raise HTTPException(status_code=400, detail="`end` must be after `start`")

    try:
        provider = get_provider()
    except MarketDataConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    service = MarketDataService(provider)
    try:
        candles = service.get_candles(symbol, timeframe, start, end)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Provider request failed: {exc}") from exc

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "provider": provider.name,
        "bars": [
            {"time": c.timestamp_utc, "open": c.open, "high": c.high, "low": c.low, "close": c.close}
            for c in candles
        ],
    }


# ============================================================================
# ON-DEMAND BACKTEST EXECUTION - Roadmap Phase 3 Task 3. Stateless: no
# persistence, no DB schema, no frontend (Decision 7 - Task 4 owns
# backtest_runs/backtest_run_trades in a new app/backtest/repository.py;
# Task 5 owns the frontend store/UI). Registers unconditionally (Decision 6):
# on a deployment missing pandas/numpy (structure_engine.py's dependency,
# still requirements-dev.txt-only per Decision 4) this reports 503, the same
# "missing capability is a normal, reportable state" pattern
# /api/telegram/status and /api/marketdata/status already use, rather than
# environment-conditional route registration.
# ============================================================================
from .backtest.runner import (  # noqa: E402
    BacktestEngineUnavailable,
    BacktestInputTooLarge,
    BacktestSymbolNotFound,
    run as _run_backtest_engine,
    validation_for as _backtest_validation_for,
)

# A ~100k-bar pure-Python loop under the GIL would otherwise visibly degrade
# /api/dataset and every other concurrent request while it runs. This is a
# single-run guard, not a queue: a second concurrent request is rejected
# (429) rather than queued, since queuing would need its own state/eviction
# story that this stateless task is explicitly not scoped to build (Decision
# 7).
_backtest_run_lock = threading.Lock()


class BacktestRunRequest(BaseModel):
    symbol: str
    timeframe: str
    # gt=0: structure_engine.py's breakevenWr = 100 / (1 + RR_RATIO) divides
    # by zero at rr_ratio=-1 and produces a nonsensical (negative or >100%)
    # breakeven win rate for any rr_ratio <= 0 - reject those at the request
    # boundary (a clean 422) rather than letting them reach the engine and
    # surface as an opaque 502.
    rr_ratio: float = Field(default=2.45, gt=0)


class BacktestValidation(BaseModel):
    status: Literal["validated", "experimental"]
    validated: bool
    message: str


class BacktestConfigOut(BaseModel):
    rrRatio: float


class BacktestRunResponse(BaseModel):
    symbol: str
    timeframe: str
    strategy: Literal["smc_fib_ote"]
    config: BacktestConfigOut
    validation: BacktestValidation
    trades: list[Trade]
    stats: Stats


@app.post("/api/backtest/run", response_model=BacktestRunResponse)
def post_backtest_run(req: BacktestRunRequest):
    """Stateless, synchronous, on-demand run of the one SMC/fib-OTE strategy
    against any (symbol, timeframe) app/backtest/runner.py catalogs. `def`,
    not `async def`, deliberately: FastAPI runs a sync route in its
    threadpool, keeping the engine's pure-Python loop off the event loop
    /api/dataset and everything else share. Returns only {trades, stats} -
    never bars/daily*/SMC-event arrays, which already have a home in
    /api/dataset and would multi-MB-duplicate it here."""
    if not _backtest_run_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="a backtest run is already in progress")
    try:
        try:
            result = _run_backtest_engine(req.symbol, req.timeframe, req.rr_ratio)
        except BacktestSymbolNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except BacktestInputTooLarge as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except BacktestEngineUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Backtest engine failed: {exc}") from exc
    finally:
        _backtest_run_lock.release()

    validation = _backtest_validation_for(req.symbol, req.timeframe)
    trades = [
        Trade(
            dir=t[0], entryBar=t[1], entryPrice=t[2], sl=t[3], tp=t[4],
            exitBar=t[5], result=t[6], r=t[7], setup=t[8],
        )
        for t in result["trades"]
    ]
    return BacktestRunResponse(
        symbol=req.symbol,
        timeframe=req.timeframe,
        strategy="smc_fib_ote",
        config=BacktestConfigOut(rrRatio=req.rr_ratio),
        validation=BacktestValidation(**validation),
        trades=trades,
        stats=Stats(**result["stats"]),
    )
