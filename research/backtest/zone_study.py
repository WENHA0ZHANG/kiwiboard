import os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, ema, fwd_maxdd, fwd_ret
SP = WORK
def study(sym, start='1995-01-01'):
    df = yahoo(sym); c = df['close']
    e8, e21 = ema(c, 8), ema(c, 21)
    below = (e8 < e21).astype(int)
    streak = below.groupby((below != below.shift()).cumsum()).cumsum() * below
    hi60 = c.rolling(60).max()
    dd_in = (c / hi60 - 1).rolling(30).min()          # deepest pullback in the last 30 days
    zone = (c > e21) & (c.shift(1) <= e21.shift(1)) & (streak.shift(1).rolling(5).max() >= 10) & (dd_in <= -0.05)
    tradeable = (c > e21) & (e8 > e21)
    r20, r60 = fwd_ret(c, 20), fwd_ret(c, 60); dd40 = fwd_maxdd(c, 40)
    m = (c.index >= start) & r60.notna()
    out = []
    for name, s in [('all days', pd.Series(True, index=c.index)), ('tradeable (c>21 & 8>21)', tradeable), ('not tradeable', ~tradeable), ('ZONE re-entry', zone)]:
        s = s & m
        out.append(dict(sym=sym, state=name, days=int(s.sum()), r20=round(r20[s].mean()*100, 2), win20=round((r20[s] > 0).mean()*100, 1),
                        r60=round(r60[s].mean()*100, 2), win60=round((r60[s] > 0).mean()*100, 1), p_dd5_40=round((dd40[s] <= -.05).mean()*100, 1)))
    z = zone & m
    return out, list(c.index[z])
rows = []
for sym in ('^GSPC', '^NDX'):
    o, dates = study(sym); rows += o
    if sym == '^NDX': zd = dates
print(pd.DataFrame(rows).to_string(index=False))
print('NDX ZONE dates since 2018:', [d.strftime('%Y-%m-%d') for d in zd if d.year >= 2018])
