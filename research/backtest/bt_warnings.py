import os, sys, glob
import numpy as np, pandas as pd
from bt_common import load_bars, features, SP
syms = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(SP, 'data', 'stocks', '*.json')))
recs = []
for sym in syms:
    b = load_bars(sym); f = features(b); c, h, l, o, v = b['c'], b['h'], b['l'], b['o'], b['v']; n = len(c)
    e8, e21, e50 = f['e8'], f['e21'], f['e50']; atr = f['atr']
    s = pd.Series(c)
    r10 = (s.shift(-10) / s - 1).values; r20 = (s.shift(-20) / s - 1).values; r60 = (s.shift(-60) / s - 1).values
    minf = pd.Series(l[::-1]).rolling(20, min_periods=1).min().values[::-1]
    dd20 = np.r_[minf[1:], np.nan] / c - 1
    above21 = (c > e21).astype(int); run21 = np.zeros(n, int); above8 = (c > e8).astype(int); run8 = np.zeros(n, int)
    for i in range(1, n):
        run21[i] = run21[i - 1] + 1 if above21[i] else 0
        run8[i] = run8[i - 1] + 1 if above8[i] else 0
    hi20 = pd.Series(h).shift(1).rolling(20).max().values
    gap3 = (o > np.r_[np.nan, c[:-1]] * 1.03).astype(int); gaps10 = pd.Series(gap3).rolling(10).sum().values
    wick = np.where(h > l, ((h - np.maximum(o, c)) + (np.minimum(o, c) - l)) / (h - l), 0)
    wick15 = pd.Series(wick).rolling(15).mean().values
    width15 = (pd.Series(h).rolling(15).max() - pd.Series(l).rolling(15).min()).values / c * 100
    vcv15 = (pd.Series(v).rolling(15).std() / pd.Series(v).rolling(15).mean()).values
    start = int(np.searchsorted(b['d'], '2018-01-02'))
    for t in range(max(start, 260), n - 60):
        if not (c[t] > e50[t] and e21[t] > e50[t] and f['dv20'][t] >= 2e7): continue
        near_hi = c[t] >= 0.9 * f['hi252'][t]
        recs.append((sym, t, r10[t], r20[t], r60[t], dd20[t],
            c[t] >= e50[t] + 7 * atr[t],
            f['rsi'][t] >= 75,
            f['upstreak'][t] >= 4,
            c[t] < e21[t] and run21[t - 1] >= 20,
            c[t] < e8[t] and run8[t - 1] >= 10,
            bool(c[t] < hi20[t - 2] and max(c[t - 3:t]) > hi20[t - 2]) if t >= 3 and hi20[t - 2] == hi20[t - 2] else False,
            bool(near_hi and width15[t] >= 4 * f['adr'][t] and wick15[t] >= 0.55 and vcv15[t] >= 0.6),
            bool(f['r1m'][t] >= 50 and f['upstreak'][t] >= 3 and gaps10[t] >= 2 and c[t] >= e50[t] + 10 * atr[t]),
            bool(near_hi and c[t] < o[t] and v[t] >= 2 * f['v50'][t] and (c[t] - l[t]) <= 0.3 * (h[t] - l[t]))))
cols = ['sym', 't', 'r10', 'r20', 'r60', 'dd20', 'extended 7ATR over EMA50', 'RSI>=75', '4+ up days in a row', 'first close < EMA21 after 20d above',
        'first close < EMA8 after 10d above', 'failed breakout (back under 20d high)', 'unhealthy base (wide, wicky, erratic vol)', 'parabolic (Goku-style)', 'high-volume down day near high']
R = pd.DataFrame(recs, columns=cols)
base = R
rows = [dict(signal='uptrend days (baseline)', days=len(base), r10=base.r10.mean()*100, r20=base.r20.mean()*100, med20=base.r20.median()*100, p_dd10_20d=(base.dd20 <= -.10).mean()*100, r60=base.r60.mean()*100)]
for k in cols[6:]:
    x = R[R[k]]
    rows.append(dict(signal=k, days=len(x), r10=x.r10.mean()*100, r20=x.r20.mean()*100, med20=x.r20.median()*100, p_dd10_20d=(x.dd20 <= -.10).mean()*100, r60=x.r60.mean()*100))
pd.set_option('display.width', 250)
print(pd.DataFrame(rows).set_index('signal').round(2).to_string())
