# Terminal backend

FastAPI + DuckDB. The database is the only thing the API ever reads from -
it never touches the CSV or runs the engine live.

## First-time setup

```
py -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe build_db.py     # CSV -> app/structure_engine.py -> data.duckdb
```

## Run

```
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload
```

Docs at http://localhost:8000/docs once it's running.

## Rebuilding the data

Whenever `EURUSD60 (1).csv` changes, or `app/structure_engine.py`'s logic
changes, re-run `build_db.py` - it drops and recreates `data.duckdb` from
scratch. The frontend doesn't need to change or restart; it always reads
whatever's currently in the database.

## Schema

- `candles(symbol, timeframe, bar_index, time, open, high, low, close)`
- `swing_points(symbol, timeframe, bar_index, price, type, kind)`
- `bos_events(symbol, timeframe, bar_start, bar_end, price, direction, kind)` - kind is `bos` (continuation) or `choch` (first break against the prior trend)
- `fvg_events(symbol, timeframe, bar_index, top, bottom, direction)` - 3-candle Fair Value Gaps (wick-based), pure pattern match
- `volume_imbalance_events(symbol, timeframe, bar_index, top, bottom, direction)` - 2-candle body gaps (open/close, ignoring wicks) - same idea as FVG, no real tick volume needed despite the name
- `liquidity_events(symbol, timeframe, bar_start, bar_end, price, direction)` - clusters of 2+ equal swing highs/lows within a small price tolerance; direction is `sell_side` (above equal highs) or `buy_side` (below equal lows)
- `order_blocks(symbol, bar_index, bar_end, top, bottom, direction)` - derived from the same impulse legs that anchor each trade's fib/OTE; bar_end is that leg's BOS confirmation bar, used as the box's right edge; 1H only
- `trades(symbol, dir, entry_bar, entry_price, sl, tp, exit_bar, result, r, setup)` - 1H only, the strategy never trades daily
- `stats(symbol, total, wins, losses, win_rate, expectancy, rr, breakeven_wr, by_setup)`
- `symbols(symbol, label)`
