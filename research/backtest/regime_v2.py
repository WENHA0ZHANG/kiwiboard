"""Proposed risk side v2: replay 2025-2026 next to v1, and grade the long-history part."""
import os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, fred, episodes
import regime_replay as rr
SP = WORK
D = pd.read_pickle(os.path.join(SP, 'D2.pkl')); idx = D.index; c = D['c']
br = pd.read_csv(os.path.join(SP, 'breadth.csv'), index_col=0, parse_dates=True).reindex(idx)
hy = fred('BAMLH0A0HYM2').reindex(idx, method='ffill').shift(1)
real = D['dfii10'].shift(1); nom = D['dgs10'].shift(1); nf = D['nfci'].shift(5); baa = D['baa'].shift(1)
def t2(x, a, b): return np.where(x >= b, -2, np.where(x >= a, -1, 0))
rates = np.minimum(t2(real.diff(20), .25, .40), t2(nom.diff(20), .40, .60))
R = pd.DataFrame(index=idx)
R['rates'] = rates * 1.0
R['move'] = t2(D['move'], 110, 130) * 1.0
R['nfci'] = t2(nf.diff(20), .05, .10) * 1.0
R['skew'] = t2(D['skew'], 150, 160) * 0.8
R['narrow'] = np.where((c >= D['hi252'] * 0.98) & (br['spx50'] < 55), -1, 0) * 1.0
R['credit_hy'] = np.minimum(t2(hy.diff(20), .40, .75), t2(hy - hy.rolling(60).min(), .60, 1.0)) * 1.5
R['credit_baa'] = np.minimum(t2(baa.diff(20), .15, .25), t2(baa - baa.rolling(60).min(), .25, .40)) * 1.5
for k in R: R[k] = R[k].where(~pd.isna(R[k]), 0)
# long-history grade (credit via the Baa proxy; breadth only exists from 2016)
risk_long = -(R[['rates', 'move', 'nfci', 'skew', 'narrow', 'credit_baa']].sum(axis=1))
m = (idx >= '2003-02-01') & D['dd60'].notna()
print('v2 risk points (long history, 2003-2026) vs later S&P drawdowns:')
rows = []
for lo, hi_ in [(0, 0.01), (0.01, 1.5), (1.5, 3), (3, 4.5), (4.5, 99)]:
    s = m & (risk_long >= lo) & (risk_long < hi_)
    ep, _ = episodes(pd.Series(s, index=idx))
    rows.append(dict(bucket=f'{lo}-{hi_}', days=int(s.sum()), share=round(s.sum()/m.sum()*100,1), p_dd5_40d=round((D.loc[s,'dd40']<=-.05).mean()*100,1),
                     p_dd10_60d=round((D.loc[s,'dd60']<=-.10).mean()*100,1), r20=round(D.loc[s,'r20'].mean()*100,2), r60=round(D.loc[s,'r60'].mean()*100,2)))
print(pd.DataFrame(rows).to_string(index=False))
# 2025-2026 replay: v1 as in production vs v2 (new risk side + fixed breadth, greed-level tiers removed)
days = c[c.index >= '2025-05-01'].index
wide = rr.load_obs(breadth_override=br['ndx20'].dropna())
v1 = rr.replay(rr.load_obs(), days)
v2b = rr.replay(wide, days)
drop = {'vix': lambda v: v < 14, 'sp500_rsi': lambda v: v > 70, 'nasdaq100_above_20d_ma': lambda v: v > 80, 'us_high_yield_spread': lambda v: (v if v > 30 else v*100) <= 270, 'cboe_skew': lambda v: v >= 155}
out = []
for d in days:
    row = v2b.loc[d]; buy = row['buy']; risk = row['risk']
    for col, cond in drop.items():
        v = row.get(col)
        if v == v and v is not None and cond(v):
            t = rr.tier(col, v, True); risk -= -t * rr.W[col]
    newrisk = -R.loc[d, ['rates', 'move', 'nfci', 'skew', 'narrow', 'credit_hy']].sum()
    out.append(dict(date=d, spx=c.loc[d], v1=v1.loc[d, 'score'], v2=round(buy - max(risk, 0) - newrisk, 2), v2_buy=round(buy, 2), v2_risk=round(max(risk, 0) + newrisk, 2),
                    new=' '.join(f"{k}{R.loc[d, k]:+.1f}" for k in ['rates', 'move', 'nfci', 'skew', 'narrow', 'credit_hy'] if R.loc[d, k])))
O = pd.DataFrame(out).set_index('date')
O['dd'] = (O['spx'] / O['spx'].cummax() - 1) * 100
def band(s):
    return 'Strong Buy' if s >= 9 else 'Buy' if s >= 4.5 else 'Cautious Buy' if s >= 1.5 else 'Neutral' if s >= -1.5 else 'Caution' if s >= -4.5 else 'Risk' if s >= -9 else 'Strong Risk'
O['v1_band'] = O['v1'].map(band); O['v2_band'] = O['v2'].map(band)
pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 60)
sel = O.loc['2026-01-01':]
print(sel[sel.index.weekday == 4][['spx', 'dd', 'v1', 'v1_band', 'v2', 'v2_band', 'v2_risk', 'new']].round(2).to_string())
O.to_csv(os.path.join(SP, 'regime_v1_v2.csv'))
