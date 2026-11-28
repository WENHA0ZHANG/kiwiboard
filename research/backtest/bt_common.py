"""Bar loading, per-stock features and the trade simulator for the stock tests."""
import os, json, glob
from paths import WORK
import numpy as np, pandas as pd
SP = WORK
def load_bars(sym):
    rows = json.load(open(os.path.join(SP, 'data', 'stocks', sym + '.json')))
    a = np.array([r[1:] for r in rows], dtype=float)
    return dict(d=np.array([r[0] for r in rows]), o=a[:, 0], h=a[:, 1], l=a[:, 2], c=a[:, 3], v=a[:, 4])
def ema(x, n):
    out = np.empty_like(x); k = 2 / (n + 1); out[0] = x[0]
    for i in range(1, len(x)): out[i] = x[i] * k + out[i - 1] * (1 - k)
    return out
def features(b):
    c, h, l, o, v = b['c'], b['h'], b['l'], b['o'], b['v']
    n = len(c); f = {}
    f['e8'], f['e21'], f['e50'] = ema(c, 8), ema(c, 21), ema(c, 50)
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))
    f['atr'] = pd.Series(tr).rolling(14).mean().values
    f['adr'] = pd.Series(np.where(l > 0, h / l - 1, np.nan)).rolling(20).mean().values * 100
    f['v50'] = pd.Series(v).shift(1).rolling(50, min_periods=20).mean().values
    f['dv20'] = pd.Series(v * c).rolling(20).mean().values
    s = pd.Series(c)
    f['sma200'] = s.rolling(200).mean().values; f['hi252'] = pd.Series(h).rolling(252, min_periods=120).max().values
    f['r6m'] = (s / s.shift(126) - 1).values * 100; f['r1m'] = (s / s.shift(21) - 1).values * 100
    d = s.diff(); up = d.clip(lower=0); dn = (-d).clip(lower=0)
    f['rsi'] = (100 - 100 / (1 + up.ewm(alpha=1/14, adjust=False).mean() / dn.ewm(alpha=1/14, adjust=False).mean())).values
    upd = (d > 0).astype(int).values; st = np.zeros(n, int)
    for i in range(1, n): st[i] = st[i - 1] + 1 if upd[i] else 0
    f['upstreak'] = st
    return f
def simulate(b, f, j, entry, stop, model, enter_at_close=False, target_r=3.0, max_days=None):
    """Run one long trade from bar j. Returns (R multiple, exit bar)."""
    c, h, l, o = b['c'], b['h'], b['l'], b['o']; n = len(c)
    risk = entry - stop
    if risk <= 0: return None, j
    if model == 'A':
        tgt = entry + target_r * risk; md = max_days or 30
        start = j + 1
        if not enter_at_close:
            if c[j] <= stop: return (c[j] - entry) / risk, j     # failed on the breakout day itself
            if h[j] >= tgt: return target_r, j
        for k in range(start, min(n, j + md + 1)):
            if o[k] <= stop: return (o[k] - entry) / risk, k
            if l[k] <= stop: return -1.0, k
            if o[k] >= tgt: return (o[k] - entry) / risk, k
            if h[k] >= tgt: return target_r, k
        k = min(n - 1, j + md); return (c[k] - entry) / risk, k
    else:  # 'B': breakeven after +2R close, exit on a close below EMA21, max 60 days
        md = max_days or 60; st = stop
        if not enter_at_close and c[j] <= stop: return (c[j] - entry) / risk, j
        for k in range(j + 1, min(n, j + md + 1)):
            if o[k] <= st: return (o[k] - entry) / risk, k
            if l[k] <= st: return (st - entry) / risk, k
            if c[k] >= entry + 2 * risk: st = max(st, entry)
            if c[k] < f['e21'][k] and k > j + 1: return (c[k] - entry) / risk, k
        k = min(n - 1, j + md); return (c[k] - entry) / risk, k
def market():
    spy = json.load(open(os.path.join(SP, 'data', 'yahoo', 'SPY.json')))
    d = np.array([r[0] for r in spy]); c = np.array([r[4] for r in spy], float)
    e8, e21 = ema(c, 8), ema(c, 21)
    ok = (c > e21) & (e8 > e21)
    D2 = pd.read_pickle(os.path.join(SP, 'D2.pkl'))
    stress = D2['stress'].copy(); stress.index = stress.index.strftime('%Y-%m-%d')
    r6 = pd.Series(c).pct_change(126).values * 100
    return {dd: dict(ok=bool(o_), stress=float(stress.get(dd, np.nan)), spy_r6m=r6_) for dd, o_, r6_ in zip(d, ok, r6)}
