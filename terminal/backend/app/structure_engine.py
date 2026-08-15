"""
SMC 1H market-structure + backtest engine.

This is the project's original engine.py (independent-zigzag swing detection,
trend-aware BOS rules, daily-bias setup tagging) ported into a callable
function so it can run behind FastAPI instead of as a one-shot script that
writes a JSON file by hand. The algorithm itself is untouched line-for-line -
only the I/O (argument in, return value out, instead of a hardcoded path and
a print/json.dump) changed, specifically so this port couldn't silently
change backtest results.
"""
import pandas as pd
import numpy as np
from collections import defaultdict


def compute_pivots(src, length):
    ph = np.full(len(src), np.nan)
    pl = np.full(len(src), np.nan)
    for i in range(length, len(src) - length):
        w = src[i - length:i + length + 1]
        c = src[i]
        if c == w.max() and np.sum(w == c) == 1:
            ph[i + length] = c
        if c == w.min() and np.sum(w == c) == 1:
            pl[i + length] = c
    return ph, pl


def detect_fvg(high, low):
    """Fair Value Gap: a 3-candle imbalance where candle i-1's extreme never
    traded in candle i+1's range. Reported at the middle (impulse) bar. Pure
    pattern match over OHLC - the first SMC concept that ISN'T built on the
    swing/BOS state machine, proving the StructureAnalyzer shape generalizes."""
    events = []
    for i in range(1, len(high) - 1):
        if low[i + 1] > high[i - 1]:
            events.append({'bar': i, 'top': float(low[i + 1]), 'bottom': float(high[i - 1]), 'direction': 'bull'})
        elif high[i + 1] < low[i - 1]:
            events.append({'bar': i, 'top': float(low[i - 1]), 'bottom': float(high[i + 1]), 'direction': 'bear'})
    return events


def detect_volume_imbalance(open_, close):
    """Volume Imbalance: a 2-candle body gap (candle i's open/close body vs
    candle i+1's), ignoring wicks entirely - distinct from FVG, which is
    wick-based (high/low) and spans 3 candles. No real tick/volume data
    exists in this CSV, but this SMC concept is defined purely from candle
    bodies despite the name, so it doesn't need any. Reported at the second
    bar, same convention as detect_fvg."""
    events = []
    for i in range(len(open_) - 1):
        top_i = max(open_[i], close[i]); bot_i = min(open_[i], close[i])
        top_n = max(open_[i + 1], close[i + 1]); bot_n = min(open_[i + 1], close[i + 1])
        if bot_n > top_i:
            events.append({'bar': i + 1, 'top': float(bot_n), 'bottom': float(top_i), 'direction': 'bull'})
        elif top_n < bot_i:
            events.append({'bar': i + 1, 'top': float(bot_i), 'bottom': float(top_n), 'direction': 'bear'})
    return events


def detect_liquidity(swing_points, tolerance_pct=0.0006):
    """Liquidity pools: clusters of 2+ swing highs (or lows) within a small
    price tolerance of each other - "equal highs/lows" where resting
    stop-loss and breakout-entry orders pile up. Reported once per cluster,
    spanning from the first to the last swing bar in it, at the cluster's
    average price. O(n^2) per side, but n is a few thousand swings even over
    the full dataset and this only runs once at build time, not per-request."""
    def pools(points, direction):
        events = []
        used = [False] * len(points)
        for i in range(len(points)):
            if used[i]:
                continue
            group = [points[i]]
            for j in range(i + 1, len(points)):
                if used[j]:
                    continue
                if abs(points[j]['price'] - points[i]['price']) / points[i]['price'] <= tolerance_pct:
                    group.append(points[j])
                    used[j] = True
            if len(group) >= 2:
                avg_price = sum(g['price'] for g in group) / len(group)
                bar_start = min(g['bar'] for g in group)
                bar_end = max(g['bar'] for g in group)
                events.append({'bar_start': bar_start, 'bar_end': bar_end, 'price': avg_price, 'direction': direction})
        return events

    highs = [s for s in swing_points if s['kind'] == 'high' and s['bar'] is not None]
    lows = [s for s in swing_points if s['kind'] == 'low' and s['bar'] is not None]
    # sell-side liquidity rests above equal highs (stops of shorts / breakout buys);
    # buy-side liquidity rests below equal lows (stops of longs / breakout sells)
    return pools(highs, 'sell_side') + pools(lows, 'buy_side')


def _load_ohlcv(csv_path: str) -> pd.DataFrame:
    raw = pd.read_csv(csv_path, header=None, names=['raw'])
    parts = raw['raw'].str.split('\t', expand=True)
    return pd.DataFrame({
        'time': pd.to_datetime(parts[0]),
        'open': parts[1].astype(float),
        'high': parts[2].astype(float),
        'low': parts[3].astype(float),
        'close': parts[4].astype(float),
        'volume': parts[5].astype(float),
    }).reset_index(drop=True)


def compute_structure(csv_path: str, swing_len: int, use_line_source: bool) -> dict:
    """Generic SMC structure pass for any symbol/timeframe: swings, BOS/CHoCH,
    FVG, volume imbalance, liquidity - the same independent-zigzag pattern
    already proven by run_backtest()'s daily-overlay pass (compare the state
    machine below to the "Daily market-structure overlay" section there),
    just parameterized instead of hardcoded to the EURUSD 1H+daily pairing.

    Deliberately does NOT simulate trades. run_backtest()'s fib-OTE entry/SL/
    TP logic and A/B/C/D daily-bias tagging were tuned specifically for
    EURUSD's 1H+daily-bias pairing and have never been validated for any
    other symbol or timeframe - extending that silently to GBPUSD, XAUUSD, or
    other timeframes would mean fabricating backtest results nobody has
    checked, which is exactly what this project's data-validation principles
    (see the market-data architecture notes) rule out.

    `use_line_source` mirrors run_backtest()'s USE_LINE_SOURCE flag: pivots
    are detected on closing price ("line") when True, on actual high/low
    when False. This codebase already draws that same distinction between
    intraday (line source) and daily (high/low) - callers should pass True
    for intraday timeframes and False for "1d", matching that existing
    convention rather than introducing a new one per timeframe.
    """
    df = _load_ohlcv(csv_path)
    n = len(df)
    high = df['high'].values
    low = df['low'].values
    open_ = df['open'].values
    close = df['close'].values

    src_high = close if use_line_source else high
    src_low = close if use_line_source else low
    pivot_high, _ = compute_pivots(src_high, swing_len)
    _, pivot_low = compute_pivots(src_low, swing_len)

    swing_points, bos_events = [], []
    confirmed_high = np.nan; confirmed_high_bar = None
    confirmed_low = np.nan; confirmed_low_bar = None
    top_broken = True; bot_broken = True
    trend = 0

    for i in range(n):
        if not np.isnan(pivot_high[i]):
            p_bar = i - swing_len
            ph = pivot_high[i]
            tag = "H" if np.isnan(confirmed_high) else ("HH" if ph > confirmed_high else "LH")
            swing_points.append({'bar': p_bar, 'price': ph, 'type': tag, 'kind': 'high'})
            if np.isnan(confirmed_high) or (trend != -1 and ph > confirmed_high) or (trend == -1 and ph < confirmed_high):
                confirmed_high = ph; confirmed_high_bar = p_bar; top_broken = False

        if not np.isnan(pivot_low[i]):
            p_bar_l = i - swing_len
            pl = pivot_low[i]
            tag_l = "L" if np.isnan(confirmed_low) else ("LL" if pl < confirmed_low else "HL")
            swing_points.append({'bar': p_bar_l, 'price': pl, 'type': tag_l, 'kind': 'low'})
            if np.isnan(confirmed_low) or (trend != 1 and pl < confirmed_low) or (trend == 1 and pl > confirmed_low):
                confirmed_low = pl; confirmed_low_bar = p_bar_l; bot_broken = False

        # CHoCH = the first break AGAINST the just-prior trend; every other
        # break continues the existing trend (BOS) - same convention as
        # run_backtest()'s daily overlay.
        bull_bos = (not top_broken) and (not np.isnan(confirmed_high)) and (close[i] > confirmed_high)
        bear_bos = (not bot_broken) and (not np.isnan(confirmed_low)) and (close[i] < confirmed_low)
        if bull_bos:
            bos_events.append({'bar_start': confirmed_high_bar, 'bar_end': i, 'price': confirmed_high,
                                'direction': 'bull', 'kind': 'choch' if trend == -1 else 'bos'})
            top_broken = True
            trend = 1
        if bear_bos:
            bos_events.append({'bar_start': confirmed_low_bar, 'bar_end': i, 'price': confirmed_low,
                                'direction': 'bear', 'kind': 'choch' if trend == 1 else 'bos'})
            bot_broken = True
            trend = -1

    fvg_events = detect_fvg(high, low)
    volume_imbalance_events = detect_volume_imbalance(open_, close)
    liquidity_events = detect_liquidity(swing_points)

    # .astype(str) on a datetime64 column silently drops the time-of-day
    # for EVERY row if the whole column happens to be exactly midnight -
    # which is exactly what a native daily (1d) file is, every single row.
    # Intraday files never hit this (times vary row to row), which is why
    # it only surfaces on "1d" - .dt.strftime with an explicit format has
    # no such data-dependent behavior, so it's used unconditionally here.
    time_strings = df['time'].dt.strftime('%Y-%m-%d %H:%M')
    return {
        'bars': [[t, round(o, 5), round(h, 5), round(l, 5), round(c, 5)] for t, o, h, l, c in
                 zip(time_strings, df['open'], df['high'], df['low'], df['close'])],
        'swingPoints': [[int(s['bar']), round(float(s['price']), 5), s['type'], s['kind']] for s in swing_points if s['bar'] is not None],
        'bosEvents': [[int(b['bar_start']), int(b['bar_end']), round(float(b['price']), 5), b['direction'], b['kind']] for b in bos_events if b['bar_start'] is not None],
        'fvgEvents': [[int(f['bar']), round(f['top'], 5), round(f['bottom'], 5), f['direction']] for f in fvg_events],
        'volumeImbalanceEvents': [[int(v['bar']), round(v['top'], 5), round(v['bottom'], 5), v['direction']] for v in volume_imbalance_events],
        'liquidityEvents': [[int(l['bar_start']), int(l['bar_end']), round(float(l['price']), 5), l['direction']] for l in liquidity_events],
    }


def run_backtest(csv_path: str) -> dict:
    # -----------------------------------------------------------------------
    # Load 1H data
    # -----------------------------------------------------------------------
    raw = pd.read_csv(csv_path, header=None, names=['raw'])
    parts = raw['raw'].str.split('\t', expand=True)
    df = pd.DataFrame({
        'time': pd.to_datetime(parts[0]),
        'open': parts[1].astype(float),
        'high': parts[2].astype(float),
        'low': parts[3].astype(float),
        'close': parts[4].astype(float),
        'volume': parts[5].astype(float),
    }).reset_index(drop=True)
    n = len(df)

    # -----------------------------------------------------------------------
    # Build DAILY bars from the same 1H data (for the daily-bias layer)
    # -----------------------------------------------------------------------
    df['date'] = df['time'].dt.date
    daily = df.groupby('date').agg(open=('open', 'first'), high=('high', 'max'),
                                    low=('low', 'min'), close=('close', 'last')).reset_index()
    daily_date_to_idx = {d: i for i, d in enumerate(daily['date'])}
    df['daily_idx_prev'] = df['date'].map(daily_date_to_idx) - 1

    DAILY_SWING_LEN = 3
    RETRACE_THRESHOLD = 0.5

    d_open = daily['open'].values
    d_high = daily['high'].values
    d_low = daily['low'].values
    d_close = daily['close'].values
    d_pivot_high, _ = compute_pivots(d_high, DAILY_SWING_LEN)
    _, d_pivot_low = compute_pivots(d_low, DAILY_SWING_LEN)

    # ---- daily bias state machine (drives A/B/C/D setup tagging) ----
    d_trend = np.zeros(len(daily), dtype=int)
    d_confirmed_high = np.full(len(daily), np.nan)
    d_confirmed_low = np.full(len(daily), np.nan)
    d_running_max_arr = np.full(len(daily), np.nan)
    d_running_min_arr = np.full(len(daily), np.nan)

    trend_d = 0
    conf_high = np.nan
    conf_low = np.nan
    top_broken_d = True
    bot_broken_d = True
    running_max_d = np.nan
    min_since_max_d = np.nan
    running_min_d = np.nan
    max_since_min_d = np.nan

    for i in range(len(daily)):
        if np.isnan(running_max_d) or d_high[i] > running_max_d:
            running_max_d = d_high[i]; min_since_max_d = d_low[i]
        else:
            if d_low[i] < min_since_max_d: min_since_max_d = d_low[i]
        if np.isnan(running_min_d) or d_low[i] < running_min_d:
            running_min_d = d_low[i]; max_since_min_d = d_high[i]
        else:
            if d_high[i] > max_since_min_d: max_since_min_d = d_high[i]

        if not np.isnan(d_pivot_high[i]) and (trend_d != -1 or (np.isnan(conf_high) and np.isnan(conf_low))):
            conf_high = d_pivot_high[i]; top_broken_d = False; trend_d = 1
        if not np.isnan(d_pivot_low[i]) and (trend_d != 1 or (np.isnan(conf_low) and np.isnan(conf_high))):
            conf_low = d_pivot_low[i]; bot_broken_d = False; trend_d = -1

        bull_bos_d = (not top_broken_d) and (not np.isnan(conf_high)) and (d_close[i] > conf_high)
        bear_bos_d = (not bot_broken_d) and (not np.isnan(conf_low)) and (d_close[i] < conf_low)
        was_bull_d, was_bear_d = trend_d == 1, trend_d == -1

        if bull_bos_d:
            top_broken_d = True
            if was_bull_d and not np.isnan(min_since_max_d) and (np.isnan(conf_low) or min_since_max_d < conf_low):
                conf_low = min_since_max_d; bot_broken_d = False
            trend_d = 1
        if bear_bos_d:
            bot_broken_d = True
            if was_bear_d and not np.isnan(max_since_min_d) and (np.isnan(conf_high) or max_since_min_d > conf_high):
                conf_high = max_since_min_d; top_broken_d = False
            trend_d = -1

        d_trend[i] = trend_d
        d_confirmed_high[i] = conf_high
        d_confirmed_low[i] = conf_low
        d_running_max_arr[i] = running_max_d
        d_running_min_arr[i] = running_min_d

    def daily_state_for_1h_bar(idx_prev, live_close):
        if idx_prev < 0 or idx_prev >= len(daily):
            return 0, np.nan
        tr = d_trend[idx_prev]
        r_max = d_running_max_arr[idx_prev]
        r_min = d_running_min_arr[idx_prev]
        c_low = d_confirmed_low[idx_prev]
        c_high = d_confirmed_high[idx_prev]
        if tr == 1 and not np.isnan(c_low) and (r_max - c_low) > 0:
            return 1, (r_max - live_close) / (r_max - c_low)
        elif tr == -1 and not np.isnan(c_high) and (c_high - r_min) > 0:
            return -1, (live_close - r_min) / (c_high - r_min)
        return tr, np.nan

    daily_idx_prev_arr = df['daily_idx_prev'].values

    # -----------------------------------------------------------------------
    # Daily market-structure overlay, for the chart's daily timeframe view
    # only (independent zigzag - separate from the trend-locked bias state
    # machine above, which still drives A/B/C/D tagging unchanged).
    # -----------------------------------------------------------------------
    daily_swing_points, daily_bos_events = [], []
    dv_confirmed_high = np.nan; dv_confirmed_high_bar = None
    dv_confirmed_low = np.nan; dv_confirmed_low_bar = None
    dv_top_broken = True; dv_bot_broken = True
    dv_trend = 0

    for di in range(len(daily)):
        if not np.isnan(d_pivot_high[di]):
            p_bar = di - DAILY_SWING_LEN
            ph = d_pivot_high[di]
            tag = "H" if np.isnan(dv_confirmed_high) else ("HH" if ph > dv_confirmed_high else "LH")
            daily_swing_points.append({'bar': p_bar, 'price': ph, 'type': tag, 'kind': 'high'})
            if np.isnan(dv_confirmed_high) or (dv_trend != -1 and ph > dv_confirmed_high) or (dv_trend == -1 and ph < dv_confirmed_high):
                dv_confirmed_high = ph; dv_confirmed_high_bar = p_bar; dv_top_broken = False

        if not np.isnan(d_pivot_low[di]):
            p_bar_l = di - DAILY_SWING_LEN
            pl = d_pivot_low[di]
            tag_l = "L" if np.isnan(dv_confirmed_low) else ("LL" if pl < dv_confirmed_low else "HL")
            daily_swing_points.append({'bar': p_bar_l, 'price': pl, 'type': tag_l, 'kind': 'low'})
            if np.isnan(dv_confirmed_low) or (dv_trend != 1 and pl < dv_confirmed_low) or (dv_trend == 1 and pl > dv_confirmed_low):
                dv_confirmed_low = pl; dv_confirmed_low_bar = p_bar_l; dv_bot_broken = False

        dv_bull_bos = (not dv_top_broken) and (not np.isnan(dv_confirmed_high)) and (d_close[di] > dv_confirmed_high)
        dv_bear_bos = (not dv_bot_broken) and (not np.isnan(dv_confirmed_low)) and (d_close[di] < dv_confirmed_low)
        # CHoCH = the first break AGAINST the just-prior trend (a reversal
        # signal); every other break just continues the existing trend (BOS).
        # A break while no trend is established yet (dv_trend==0) is BOS too -
        # there's nothing to reverse from.
        if dv_bull_bos:
            daily_bos_events.append({'bar_start': dv_confirmed_high_bar, 'bar_end': di, 'price': dv_confirmed_high,
                                      'direction': 'bull', 'kind': 'choch' if dv_trend == -1 else 'bos'})
            dv_top_broken = True
            dv_trend = 1
        if dv_bear_bos:
            daily_bos_events.append({'bar_start': dv_confirmed_low_bar, 'bar_end': di, 'price': dv_confirmed_low,
                                      'direction': 'bear', 'kind': 'choch' if dv_trend == 1 else 'bos'})
            dv_bot_broken = True
            dv_trend = -1

    # -----------------------------------------------------------------------
    # 1H config + pivots
    # -----------------------------------------------------------------------
    SWING_LEN = 10
    USE_LINE_SOURCE = True
    MAX_IMPULSE_BARS = 150
    FIB_USE_BODY = True
    RR_RATIO = 2.45

    src_high = df['close'].values if USE_LINE_SOURCE else df['high'].values
    src_low = df['close'].values if USE_LINE_SOURCE else df['low'].values
    high = df['high'].values
    low = df['low'].values
    open_ = df['open'].values
    close = df['close'].values

    pivot_high, _ = compute_pivots(src_high, SWING_LEN)
    _, pivot_low = compute_pivots(src_low, SWING_LEN)

    # -----------------------------------------------------------------------
    # 1H state machine + setup classification
    # -----------------------------------------------------------------------
    running_max = np.nan; min_since_max = np.nan; min_since_max_bar = None
    running_min = np.nan; max_since_min = np.nan; max_since_min_bar = None
    confirmed_high = np.nan; confirmed_high_bar = None
    confirmed_low = np.nan; confirmed_low_bar = None
    top_broken = True; bot_broken = True
    trend = 0
    counter_trend_count = 0
    prev_daily_trend = 0

    swing_points, bos_events, fib_legs, trades = [], [], [], []
    pending = None
    active = None

    for i in range(n):
        d_tr, d_retr = daily_state_for_1h_bar(daily_idx_prev_arr[i], close[i])
        if d_tr != prev_daily_trend:
            counter_trend_count = 0
            prev_daily_trend = d_tr

        if not np.isnan(pivot_high[i]):
            p_bar = i - SWING_LEN
            ph = pivot_high[i]
            tag = "H" if np.isnan(confirmed_high) else ("HH" if ph > confirmed_high else "LH")
            swing_points.append({'bar': p_bar, 'price': ph, 'type': tag, 'kind': 'high'})
            if np.isnan(confirmed_high) or (trend != -1 and ph > confirmed_high) or (trend == -1 and ph < confirmed_high):
                confirmed_high = ph; confirmed_high_bar = p_bar; top_broken = False
            if tag == "LH" and active is None and pending is not None and pending['dir'] == 'long':
                pending = None

        if not np.isnan(pivot_low[i]):
            p_bar_l = i - SWING_LEN
            pl = pivot_low[i]
            tag_l = "L" if np.isnan(confirmed_low) else ("LL" if pl < confirmed_low else "HL")
            swing_points.append({'bar': p_bar_l, 'price': pl, 'type': tag_l, 'kind': 'low'})
            if np.isnan(confirmed_low) or (trend != 1 and pl < confirmed_low) or (trend == 1 and pl > confirmed_low):
                confirmed_low = pl; confirmed_low_bar = p_bar_l; bot_broken = False
            if tag_l == "HL" and active is None and pending is not None and pending['dir'] == 'short':
                pending = None

        bullish_bos = (not top_broken) and (not np.isnan(confirmed_high)) and (close[i] > confirmed_high)
        bearish_bos = (not bot_broken) and (not np.isnan(confirmed_low)) and (close[i] < confirmed_low)

        if bullish_bos:
            bos_events.append({'bar_start': confirmed_high_bar, 'bar_end': i, 'price': confirmed_high,
                                'direction': 'bull', 'kind': 'choch' if trend == -1 else 'bos'})
            top_broken = True
            trend = 1
            if active is None:
                pending = None

            is_with_trend = d_tr == 1
            is_counter = d_tr == -1
            if is_with_trend: counter_trend_count = 0
            if is_counter: counter_trend_count += 1
            if d_tr == 1:
                setup_tag = "A" if (not np.isnan(d_retr) and d_retr >= RETRACE_THRESHOLD) else "B"
            elif d_tr == -1:
                setup_tag = "C" if (not np.isnan(d_retr) and d_retr >= RETRACE_THRESHOLD) else ("D" if counter_trend_count == 1 else "C")
            else:
                setup_tag = "?"

            if confirmed_low_bar is not None:
                lookback_start = max(confirmed_low_bar, i - MAX_IMPULSE_BARS)
                if i - lookback_start > 0:
                    local_window_low = low[lookback_start:i]
                    local_low_offset = int(np.argmin(local_window_low))
                    impulse_start_bar = lookback_start + local_low_offset
                else:
                    impulse_start_bar = confirmed_low_bar
                impulse_len = i - impulse_start_bar
                if 0 < impulse_len <= MAX_IMPULSE_BARS:
                    seg_close = close[impulse_start_bar:i]; seg_open = open_[impulse_start_bar:i]
                    bull_count = int(np.sum(seg_close > seg_open)); bear_count = int(np.sum(seg_close < seg_open))
                    if bull_count > bear_count:
                        seg_top = np.maximum(seg_open, seg_close); seg_bot = np.minimum(seg_open, seg_close)
                        body_high = seg_top.max(); body_low = seg_bot.min()
                        lo_point = body_low if FIB_USE_BODY else min(low[impulse_start_bar:i + 1])
                        hi_point = body_high if FIB_USE_BODY else max(running_max, high[i])
                        fib_range = hi_point - lo_point
                        if fib_range > 0:
                            ote = hi_point - 0.71 * fib_range
                            fib_legs.append({'bar_start': impulse_start_bar, 'bar_end': i, 'lo': lo_point, 'hi': hi_point,
                                              'direction': 'bull', 'ote': ote, 'setup': setup_tag})
                            if active is None:
                                sl = lo_point; tp = ote + RR_RATIO * (ote - sl)
                                pending = {'dir': 'long', 'entry': ote, 'sl': sl, 'tp': tp, 'setup': setup_tag, 'signal_bar': i}

        if bearish_bos:
            bos_events.append({'bar_start': confirmed_low_bar, 'bar_end': i, 'price': confirmed_low,
                                'direction': 'bear', 'kind': 'choch' if trend == 1 else 'bos'})
            bot_broken = True
            trend = -1
            if active is None:
                pending = None

            is_with_trend_b = d_tr == -1
            is_counter_b = d_tr == 1
            if is_with_trend_b: counter_trend_count = 0
            if is_counter_b: counter_trend_count += 1
            if d_tr == -1:
                setup_tag_b = "A" if (not np.isnan(d_retr) and d_retr >= RETRACE_THRESHOLD) else "B"
            elif d_tr == 1:
                setup_tag_b = "C" if (not np.isnan(d_retr) and d_retr >= RETRACE_THRESHOLD) else ("D" if counter_trend_count == 1 else "C")
            else:
                setup_tag_b = "?"

            if confirmed_high_bar is not None:
                lookback_start_b = max(confirmed_high_bar, i - MAX_IMPULSE_BARS)
                if i - lookback_start_b > 0:
                    local_window_high = high[lookback_start_b:i]
                    local_high_offset = int(np.argmax(local_window_high))
                    impulse_start_bar_b = lookback_start_b + local_high_offset
                else:
                    impulse_start_bar_b = confirmed_high_bar
                impulse_len_b = i - impulse_start_bar_b
                if 0 < impulse_len_b <= MAX_IMPULSE_BARS:
                    seg_close = close[impulse_start_bar_b:i]; seg_open = open_[impulse_start_bar_b:i]
                    bear_count2 = int(np.sum(seg_close < seg_open)); bull_count2 = int(np.sum(seg_close > seg_open))
                    if bear_count2 > bull_count2:
                        seg_top = np.maximum(seg_open, seg_close); seg_bot = np.minimum(seg_open, seg_close)
                        body_high_b = seg_top.max(); body_low_b = seg_bot.min()
                        hi_point_b = body_high_b if FIB_USE_BODY else max(high[impulse_start_bar_b:i + 1])
                        lo_point_b = body_low_b if FIB_USE_BODY else min(running_min, low[i])
                        fib_range_b = hi_point_b - lo_point_b
                        if fib_range_b > 0:
                            ote_b = lo_point_b + 0.71 * fib_range_b
                            fib_legs.append({'bar_start': impulse_start_bar_b, 'bar_end': i, 'lo': lo_point_b, 'hi': hi_point_b,
                                              'direction': 'bear', 'ote': ote_b, 'setup': setup_tag_b})
                            if active is None:
                                sl_b = hi_point_b; tp_b = ote_b - RR_RATIO * (sl_b - ote_b)
                                pending = {'dir': 'short', 'entry': ote_b, 'sl': sl_b, 'tp': tp_b, 'setup': setup_tag_b, 'signal_bar': i}

        if active is not None:
            if active['dir'] == 'long':
                hit_sl = low[i] <= active['sl']; hit_tp = high[i] >= active['tp']
            else:
                hit_sl = high[i] >= active['sl']; hit_tp = low[i] <= active['tp']
            if hit_sl:
                trades.append({**active, 'exit_bar': i, 'result': 'Lose', 'r': -1.0}); active = None
            elif hit_tp:
                trades.append({**active, 'exit_bar': i, 'result': 'Win', 'r': RR_RATIO}); active = None

        if active is None and pending is not None:
            filled = (pending['dir'] == 'long' and low[i] <= pending['entry']) or \
                     (pending['dir'] == 'short' and high[i] >= pending['entry'])
            if filled:
                active = {'dir': pending['dir'], 'entry_bar': i, 'entry_price': pending['entry'],
                          'sl': pending['sl'], 'tp': pending['tp'], 'setup': pending['setup']}
                pending = None

        if np.isnan(running_max) or src_high[i] > running_max:
            running_max = src_high[i]; min_since_max = src_low[i]; min_since_max_bar = i
        else:
            if src_low[i] < min_since_max: min_since_max = src_low[i]; min_since_max_bar = i
        if np.isnan(running_min) or src_low[i] < running_min:
            running_min = src_low[i]; max_since_min = src_high[i]; max_since_min_bar = i
        else:
            if src_high[i] > max_since_min: max_since_min = src_high[i]; max_since_min_bar = i

    wins = sum(1 for t in trades if t['result'] == 'Win')
    total = len(trades)
    wr = (wins / total * 100) if total else 0.0
    exp_r = (sum(t['r'] for t in trades) / total) if total else 0.0

    by_setup = defaultdict(lambda: {'n': 0, 'w': 0, 'r': 0.0})
    for t in trades:
        s = by_setup[t['setup']]; s['n'] += 1; s['r'] += t['r']
        if t['result'] == 'Win': s['w'] += 1

    # ---- FVG: pure pattern match, independent of the swing/BOS state above ----
    fvg_events = detect_fvg(high, low)
    daily_fvg_events = detect_fvg(d_high, d_low)

    # ---- Volume Imbalance: same idea as FVG, 2-candle bodies instead of
    # 3-candle wicks - also independent of the swing/BOS state. ----
    volume_imbalance_events = detect_volume_imbalance(open_, close)
    daily_volume_imbalance_events = detect_volume_imbalance(d_open, d_close)

    # ---- Liquidity pools: built from the swing points already collected
    # above by the state machine (not a fresh pattern match), same reasoning
    # as reusing fib_legs for order blocks. ----
    liquidity_events = detect_liquidity(swing_points)
    daily_liquidity_events = detect_liquidity(daily_swing_points)

    # ---- Order Blocks: derived straight from the fib legs already computed
    # above - the OB is the candle that anchors the impulse leg driving each
    # BOS/trade setup, so this reuses that computation rather than re-deriving
    # impulse origins with separate logic. 1H only, same as trades/fib legs. ----
    order_blocks = [
        {'bar': f['bar_start'], 'bar_end': f['bar_end'], 'top': f['hi'], 'bottom': f['lo'], 'direction': f['direction']}
        for f in fib_legs
    ]

    return {
        'bars': [[str(t)[:16], round(o, 5), round(h, 5), round(l, 5), round(c, 5)] for t, o, h, l, c in
                 zip(df['time'].astype(str), df['open'], df['high'], df['low'], df['close'])],
        'swingPoints': [[int(s['bar']), round(float(s['price']), 5), s['type'], s['kind']] for s in swing_points if s['bar'] is not None],
        'bosEvents': [[int(b['bar_start']), int(b['bar_end']), round(float(b['price']), 5), b['direction'], b['kind']] for b in bos_events if b['bar_start'] is not None],
        'fibLegs': [[int(f['bar_start']), int(f['bar_end']), round(float(f['lo']), 5), round(float(f['hi']), 5), f['direction'], round(float(f['ote']), 5), f['setup']] for f in fib_legs],
        'fvgEvents': [[int(f['bar']), round(f['top'], 5), round(f['bottom'], 5), f['direction']] for f in fvg_events],
        'orderBlocks': [[int(o['bar']), int(o['bar_end']), round(float(o['top']), 5), round(float(o['bottom']), 5), o['direction']] for o in order_blocks],
        'volumeImbalanceEvents': [[int(v['bar']), round(v['top'], 5), round(v['bottom'], 5), v['direction']] for v in volume_imbalance_events],
        'liquidityEvents': [[int(l['bar_start']), int(l['bar_end']), round(float(l['price']), 5), l['direction']] for l in liquidity_events],
        'dailyBars': [[str(d) + ' 00:00', round(o, 5), round(h, 5), round(l, 5), round(c, 5)] for d, o, h, l, c in
                      zip(daily['date'].astype(str), daily['open'], daily['high'], daily['low'], daily['close'])],
        'dailySwingPoints': [[int(s['bar']), round(float(s['price']), 5), s['type'], s['kind']] for s in daily_swing_points if s['bar'] is not None],
        'dailyBosEvents': [[int(b['bar_start']), int(b['bar_end']), round(float(b['price']), 5), b['direction'], b['kind']] for b in daily_bos_events if b['bar_start'] is not None],
        'dailyFvgEvents': [[int(f['bar']), round(f['top'], 5), round(f['bottom'], 5), f['direction']] for f in daily_fvg_events],
        'dailyVolumeImbalanceEvents': [[int(v['bar']), round(v['top'], 5), round(v['bottom'], 5), v['direction']] for v in daily_volume_imbalance_events],
        'dailyLiquidityEvents': [[int(l['bar_start']), int(l['bar_end']), round(float(l['price']), 5), l['direction']] for l in daily_liquidity_events],
        'trades': [[t['dir'], int(t['entry_bar']), round(float(t['entry_price']), 5), round(float(t['sl']), 5), round(float(t['tp']), 5),
                    int(t['exit_bar']), t['result'], round(float(t['r']), 3), t['setup']] for t in trades],
        'stats': {'total': total, 'wins': wins, 'losses': total - wins, 'winRate': round(wr, 2), 'expectancy': round(exp_r, 4), 'rr': RR_RATIO, 'breakevenWr': round(100 / (1 + RR_RATIO), 2),
                  'bySetup': {k: {'n': v['n'], 'wr': round(v['w'] / v['n'] * 100, 2), 'exp': round(v['r'] / v['n'], 4)} for k, v in by_setup.items()}},
    }
