"""
SMC 1H Strategy backtest engine - full port of smc_strategy.pine, now run on
genuine 1H data with a real daily-bias layer (resampled from the same file).
"""
import pandas as pd
import numpy as np
import json

# ---------------------------------------------------------------------------
# Load 1H data
# ---------------------------------------------------------------------------
raw = pd.read_csv('/mnt/user-data/uploads/EURUSD60__1_.csv', header=None, names=['raw'])
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
print(f"Loaded {n} 1H bars, {df['time'].iloc[0]} to {df['time'].iloc[-1]}")

# ---------------------------------------------------------------------------
# Build DAILY bars from the same 1H data (for the daily-bias layer)
# ---------------------------------------------------------------------------
df['date'] = df['time'].dt.date
daily = df.groupby('date').agg(open=('open','first'), high=('high','max'),
                                  low=('low','min'), close=('close','last')).reset_index()
daily_date_to_idx = {d: i for i, d in enumerate(daily['date'])}
# map each 1H bar to "yesterday's" completed daily bar index (non-repainting, mirrors dHigh1/dClose1[1] in Pine)
df['daily_idx_prev'] = df['date'].map(daily_date_to_idx) - 1
print(f"Built {len(daily)} daily bars from the 1H data")

DAILY_SWING_LEN = 3
RETRACE_THRESHOLD = 0.5

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

d_high = daily['high'].values
d_low  = daily['low'].values
d_close = daily['close'].values
d_pivot_high, _ = compute_pivots(d_high, DAILY_SWING_LEN)
_, d_pivot_low = compute_pivots(d_low, DAILY_SWING_LEN)

# ---- run the daily state machine once, producing per-day trend/range state ----
d_trend = np.zeros(len(daily), dtype=int)
d_confirmed_high = np.full(len(daily), np.nan)
d_confirmed_low  = np.full(len(daily), np.nan)
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
    """Returns (trend, retracement_pct) using the last CLOSED daily bar + live 1H close."""
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

# ---------------------------------------------------------------------------
# Daily market-structure overlay, for the chart's daily timeframe view only.
# The trend-locked state machine above (d_trend/d_confirmed_high/low) still
# drives the A/B/C/D daily-bias tagging used by the 1H trade logic - left
# untouched so backtest results don't change. This is a separate,
# independent-zigzag pass (same fix as the 1H swing/BOS logic) purely so the
# daily chart can show real structure. No trades are ever generated from it -
# only the 1H loop below trades.
# ---------------------------------------------------------------------------
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
    if dv_bull_bos:
        daily_bos_events.append({'bar_start': dv_confirmed_high_bar, 'bar_end': di, 'price': dv_confirmed_high, 'direction': 'bull'})
        dv_top_broken = True
        dv_trend = 1
    if dv_bear_bos:
        daily_bos_events.append({'bar_start': dv_confirmed_low_bar, 'bar_end': di, 'price': dv_confirmed_low, 'direction': 'bear'})
        dv_bot_broken = True
        dv_trend = -1

# ---------------------------------------------------------------------------
# 1H config + pivots
# ---------------------------------------------------------------------------
SWING_LEN = 10
USE_LINE_SOURCE = True
MAX_IMPULSE_BARS = 150
FIB_USE_BODY = True
RR_RATIO = 2.45

src_high = df['close'].values if USE_LINE_SOURCE else df['high'].values
src_low  = df['close'].values if USE_LINE_SOURCE else df['low'].values
high = df['high'].values
low  = df['low'].values
open_ = df['open'].values
close = df['close'].values

pivot_high, _ = compute_pivots(src_high, SWING_LEN)
_, pivot_low = compute_pivots(src_low, SWING_LEN)

# ---------------------------------------------------------------------------
# 1H state machine (identical structure to before) + setup classification
# ---------------------------------------------------------------------------
running_max = np.nan; min_since_max = np.nan; min_since_max_bar = None
running_min = np.nan; max_since_min = np.nan; max_since_min_bar = None
confirmed_high = np.nan; confirmed_high_bar = None
confirmed_low = np.nan; confirmed_low_bar = None
top_broken = True; bot_broken = True
trend = 0  # 1 = bullish structure active, -1 = bearish, 0 = not yet established
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

    # Swing points still register independently for every raw pivot (true
    # zigzag), so HH/LH/LL/HL labelling stays balanced and every leg gets a
    # visible tag. But confirmed_high/confirmed_low - the levels that actually
    # arm a BOS - are NOT overwritten by every pivot: while trend is bullish,
    # only a genuine higher high extends the ceiling (a lower high is a failed
    # push and must not lower the bar for what counts as a break); the low
    # side only tightens the invalidation stop upward on a higher low, mirror
    # for a bearish trend. Otherwise a single sustained move was getting
    # chopped into a cascade of fake BOS against each minor intervening pivot
    # instead of one real break of the level that actually mattered.
    if not np.isnan(pivot_high[i]):
        p_bar = i - SWING_LEN
        ph = pivot_high[i]
        tag = "H" if np.isnan(confirmed_high) else ("HH" if ph > confirmed_high else "LH")
        swing_points.append({'bar': p_bar, 'price': ph, 'type': tag, 'kind': 'high'})
        if np.isnan(confirmed_high) or (trend != -1 and ph > confirmed_high) or (trend == -1 and ph < confirmed_high):
            confirmed_high = ph; confirmed_high_bar = p_bar; top_broken = False
        # a lower high means the impulse that produced a pending long failed to
        # extend - the range it was drawn from is exhausted, so drop the setup
        # rather than let it sit and fill later, deep into what is now a reversal
        if tag == "LH" and active is None and pending is not None and pending['dir'] == 'long':
            pending = None

    if not np.isnan(pivot_low[i]):
        p_bar_l = i - SWING_LEN
        pl = pivot_low[i]
        tag_l = "L" if np.isnan(confirmed_low) else ("LL" if pl < confirmed_low else "HL")
        swing_points.append({'bar': p_bar_l, 'price': pl, 'type': tag_l, 'kind': 'low'})
        if np.isnan(confirmed_low) or (trend != 1 and pl < confirmed_low) or (trend == 1 and pl > confirmed_low):
            confirmed_low = pl; confirmed_low_bar = p_bar_l; bot_broken = False
        # mirror: a higher low invalidates a pending short drawn off the prior downswing
        if tag_l == "HL" and active is None and pending is not None and pending['dir'] == 'short':
            pending = None

    bullish_bos = (not top_broken) and (not np.isnan(confirmed_high)) and (close[i] > confirmed_high)
    bearish_bos = (not bot_broken) and (not np.isnan(confirmed_low)) and (close[i] < confirmed_low)

    if bullish_bos:
        bos_events.append({'bar_start': confirmed_high_bar, 'bar_end': i, 'price': confirmed_high, 'direction': 'bull'})
        top_broken = True
        trend = 1
        # a fresh BOS supersedes any not-yet-filled setup from the prior range -
        # only the fib drawn off the latest impulse leg is ever tradable
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
            # Anchor the impulse leg to the LOCAL low within a recent lookback,
            # not the long-term structural confirmedLow (which can be over a
            # year old by the time BOS fires - see debugging notes).
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
                    lo_point = body_low if FIB_USE_BODY else min(low[impulse_start_bar:i+1])
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
        bos_events.append({'bar_start': confirmed_low_bar, 'bar_end': i, 'price': confirmed_low, 'direction': 'bear'})
        bot_broken = True
        trend = -1
        # a fresh BOS supersedes any not-yet-filled setup from the prior range -
        # only the fib drawn off the latest impulse leg is ever tradable
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
                    hi_point_b = body_high_b if FIB_USE_BODY else max(high[impulse_start_bar_b:i+1])
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

print(f"Swing points: {len(swing_points)}, BOS events: {len(bos_events)}, Fib legs: {len(fib_legs)}, Trades: {len(trades)}")

wins = sum(1 for t in trades if t['result'] == 'Win')
total = len(trades)
wr = (wins/total*100) if total else float('nan')
exp_r = (sum(t['r'] for t in trades)/total) if total else float('nan')
print(f"Win rate: {wr:.1f}%  Expectancy: {exp_r:+.3f}R  Breakeven: {100/(1+RR_RATIO):.1f}%")

from collections import defaultdict
by_setup = defaultdict(lambda: {'n':0,'w':0,'r':0.0})
for t in trades:
    s = by_setup[t['setup']]; s['n']+=1; s['r']+=t['r']
    if t['result']=='Win': s['w']+=1
for k,v in sorted(by_setup.items()):
    print(f"  Setup {k}: n={v['n']} WR={v['w']/v['n']*100:.1f}% Exp={v['r']/v['n']:+.2f}R")

export = {
    'bars': [[str(t)[:16], round(o,5), round(h,5), round(l,5), round(c,5)] for t, o, h, l, c in
              zip(df['time'].astype(str), df['open'], df['high'], df['low'], df['close'])],
    'swingPoints': [[int(s['bar']), round(float(s['price']),5), s['type'], s['kind']] for s in swing_points if s['bar'] is not None],
    'bosEvents': [[int(b['bar_start']), int(b['bar_end']), round(float(b['price']),5), b['direction']] for b in bos_events if b['bar_start'] is not None],
    'fibLegs': [[int(f['bar_start']), int(f['bar_end']), round(float(f['lo']),5), round(float(f['hi']),5), f['direction'], round(float(f['ote']),5), f['setup']] for f in fib_legs],
    'dailyBars': [[str(d)+' 00:00', round(o,5), round(h,5), round(l,5), round(c,5)] for d, o, h, l, c in
                   zip(daily['date'].astype(str), daily['open'], daily['high'], daily['low'], daily['close'])],
    'dailySwingPoints': [[int(s['bar']), round(float(s['price']),5), s['type'], s['kind']] for s in daily_swing_points if s['bar'] is not None],
    'dailyBosEvents': [[int(b['bar_start']), int(b['bar_end']), round(float(b['price']),5), b['direction']] for b in daily_bos_events if b['bar_start'] is not None],
    'trades': [[t['dir'], int(t['entry_bar']), round(float(t['entry_price']),5), round(float(t['sl']),5), round(float(t['tp']),5),
                 int(t['exit_bar']), t['result'], round(float(t['r']),3), t['setup']] for t in trades],
    'stats': {'total': total, 'wins': wins, 'losses': total-wins, 'winRate': round(wr,2), 'expectancy': round(exp_r,4), 'rr': RR_RATIO, 'breakevenWr': round(100/(1+RR_RATIO),2),
               'bySetup': {k: {'n': v['n'], 'wr': round(v['w']/v['n']*100,2), 'exp': round(v['r']/v['n'],4)} for k,v in by_setup.items()}},
}
with open('/home/claude/backtest/results.json', 'w') as f:
    json.dump(export, f, separators=(',',':'))

trades_df = pd.DataFrame(trades)
if len(trades_df):
    trades_df['entry_time'] = trades_df['entry_bar'].apply(lambda b: df['time'].iloc[b])
    trades_df['exit_time'] = trades_df['exit_bar'].apply(lambda b: df['time'].iloc[b])
    trades_df.to_csv('/home/claude/backtest/trades.csv', index=False)
print("Exported results.json and trades.csv")
