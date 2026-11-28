import os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, fred, ema, rsi_wilder, fwd_maxdd, fwd_ret, episodes
SP = WORK
spx = yahoo('^GSPC'); ndx = yahoo('^NDX'); spy = yahoo('SPY')
c = spx['close']; idx = c.index
D = pd.DataFrame(index=idx); D['c'] = c
f = lambda s: s.reindex(idx, method='ffill')
D['vix'] = f(yahoo('^VIX')['close']); D['skew'] = f(yahoo('^SKEW')['close'])
D['vix3m'] = f(yahoo('^VIX3M')['close']); D['move'] = f(yahoo('^MOVE')['close'])
D['dgs10'] = f(fred('DGS10')); D['dgs2'] = f(fred('DGS2')); D['yc'] = f(fred('T10Y2Y'))
D['dfii10'] = f(fred('DFII10')); D['baa'] = f(fred('BAA10Y')); D['nfci'] = f(fred('NFCI'))
br = pd.read_csv(os.path.join(SP, 'breadth.csv'), index_col=0, parse_dates=True)
D['ndx20'] = br['ndx20'].reindex(idx); D['spx50b'] = br['spx50'].reindex(idx)
D['ndxc'] = f(ndx['close'])
D['rsi'] = rsi_wilder(c)
D['e8'] = ema(c, 8); D['e21'] = ema(c, 21); D['sma50'] = c.rolling(50).mean(); D['sma200'] = c.rolling(200).mean()
D['hi252'] = c.rolling(252, min_periods=60).max(); D['ndxhi'] = D['ndxc'].rolling(252, min_periods=60).max()
D['dd40'] = fwd_maxdd(c, 40); D['dd60'] = fwd_maxdd(c, 60); D['r20'] = fwd_ret(c, 20); D['r60'] = fwd_ret(c, 60)
# yield-curve window as in production: inverted at some point in the prior 720 calendar days
yc = fred('T10Y2Y'); inv = (yc < 0).astype(int)
inv720 = inv.rolling('720D').max().reindex(idx, method='ffill').fillna(0) > 0
# distribution days on SPY volume
sv = spy['volume'].reindex(idx); sc = spy['close'].reindex(idx)
dist = ((sc.pct_change() <= -0.002) & (sv > sv.shift(1))).astype(int)
D['dist25'] = dist.rolling(25).sum()
up = (D['e8'] > D['e21']).astype(int)
D['up_streak'] = up.groupby((up != up.shift()).cumsum()).cumsum() * up
near = lambda pct: c >= D['hi252'] * (1 - pct)
S = {
 'P vix<14': D['vix'] < 14,
 'P rsi>70': D['rsi'] > 70,
 'P skew>=155': D['skew'] >= 155,
 'P yc window': inv720 & D['yc'].between(-0.05, 0.6),
 'P ndx20>80': D['ndx20'] > 80,
 'P ndx20>90': D['ndx20'] > 90,
 'C 10y +40bp/20d': D['dgs10'].diff(20) >= 0.40,
 'C 10y>=4 & +30bp/20d': (D['dgs10'] >= 4.0) & (D['dgs10'].diff(20) >= 0.30),
 'C real10y +30bp/20d': D['dfii10'].diff(20) >= 0.30,
 'C baa +20bp/20d': D['baa'].diff(20) >= 0.20,
 'C baa +30bp off 60d low': D['baa'] - D['baa'].rolling(60).min() >= 0.30,
 'C vix up at high': near(0.02) & (D['vix'] >= D['vix'].rolling(10).min() * 1.25),
 'C vix/vix3m>=0.95 near hi': near(0.05) & (D['vix'] / D['vix3m'] >= 0.95),
 'C spx >=12% over 200d': c >= D['sma200'] * 1.12,
 'C trend break (8<21, c<21)': (c < D['e21']) & (D['e8'] < D['e21']),
 'C ndx near hi & ndx20<=50': (D['ndxc'] >= D['ndxhi'] * 0.97) & (D['ndx20'] <= 50),
 'C ndx20 rollover 80->55': (D['ndx20'].rolling(15).max() >= 80) & (D['ndx20'] <= 55) & (D['ndxc'] >= D['ndxhi'] * 0.96),
 'C dist days>=6/25': D['dist25'] >= 6,
 'C nfci +0.10/4w': D['nfci'].diff(20) >= 0.10,
 'C move>=120': D['move'] >= 120,
 'C 8>21 streak>=40d': D['up_streak'] >= 40,
}
def stats(sig, start='1990-01-01'):
    m = (D.index >= start) & D['dd60'].notna()
    s = sig.fillna(False) & m
    base5 = (D.loc[m, 'dd40'] <= -0.05).mean(); base10 = (D.loc[m, 'dd60'] <= -0.10).mean()
    n = int(s.sum())
    if n == 0: return dict(days=0)
    p5 = (D.loc[s, 'dd40'] <= -0.05).mean(); p10 = (D.loc[s, 'dd60'] <= -0.10).mean()
    ep, starts = episodes(sig.fillna(False) & m)
    return dict(start=start[:4], days=n, episodes=ep, p_dd5_40d=round(p5*100,1), base5=round(base5*100,1), lift5=round(p5/base5,2),
                p_dd10_60d=round(p10*100,1), base10=round(base10*100,1), r20=round(D.loc[s,'r20'].mean()*100,2), base_r20=round(D.loc[m,'r20'].mean()*100,2),
                r60=round(D.loc[s,'r60'].mean()*100,2), base_r60=round(D.loc[m,'r60'].mean()*100,2))
rows = []
for k, v in S.items():
    first = v[v.fillna(False)].index.min() if v.fillna(False).any() else None
    st = '2016-03-01' if 'ndx20' in k else ('2003-02-01' if 'real' in k else ('2008-01-01' if 'vix3m' in k else ('2003-01-01' if 'move' in k else '1990-01-01')))
    r = stats(v, st); r['signal'] = k; rows.append(r)
T = pd.DataFrame(rows).set_index('signal')
pd.set_option('display.width', 250)
print(T.to_string())
D.to_pickle(os.path.join(SP, 'D.pkl'))
import pickle; pickle.dump({k: v for k, v in S.items()}, open(os.path.join(SP, 'S.pkl'), 'wb'))
