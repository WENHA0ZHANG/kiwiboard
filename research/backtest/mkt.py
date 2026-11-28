"""Shared loaders + indicator helpers for the market-level tests."""
import json, os
from paths import WORK
import numpy as np, pandas as pd
SP = WORK
def yahoo(sym, folder='yahoo'):
    p = os.path.join(SP, 'data', folder, sym.replace('^', '_') + '.json')
    rows = json.load(open(p))
    df = pd.DataFrame(rows, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
    df['date'] = pd.to_datetime(df['date'])
    return df.drop_duplicates('date', keep='last').set_index('date').sort_index()
def fred(sid):
    df = pd.read_csv(os.path.join(SP, 'data', 'fred', sid + '.csv'))
    df.columns = ['date', 'v']
    df['date'] = pd.to_datetime(df['date'])
    df['v'] = pd.to_numeric(df['v'], errors='coerce')
    return df.dropna().set_index('date')['v']
def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()
def rsi_wilder(close, n=14):
    d = close.diff()
    up = d.clip(lower=0); dn = (-d).clip(lower=0)
    au = up.ewm(alpha=1/n, adjust=False).mean(); ad = dn.ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100 / (1 + au / ad)
def fwd_maxdd(close, h):
    """Max drawdown from today's close over the next h days (negative fraction)."""
    c = close.values; out = np.full(len(c), np.nan)
    for i in range(len(c) - 1):
        j = min(len(c), i + h + 1)
        if i + 1 >= j: continue
        out[i] = c[i + 1:j].min() / c[i] - 1
        if i + h >= len(c): out[i] = np.nan
    return pd.Series(out, index=close.index)
def fwd_ret(close, h):
    return close.shift(-h) / close - 1
def episodes(sig, gap=10):
    """Count separate firing episodes (a new one starts after `gap` quiet days)."""
    idx = np.flatnonzero(sig.fillna(False).values)
    if not len(idx): return 0, []
    starts = [idx[0]]
    for a, b in zip(idx[:-1], idx[1:]):
        if b - a > gap: starts.append(b)
    return len(starts), [sig.index[i] for i in starts]
