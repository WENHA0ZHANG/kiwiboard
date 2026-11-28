import os, sys
from paths import WORK
import numpy as np, pandas as pd
SP = WORK
T = pd.read_pickle(os.path.join(SP, 'bt', 'pattern_trades.pkl'))
def summ(x, label):
    if not len(x): return dict(filter=label, n=0)
    return dict(filter=label, n=len(x), win_3R=round(x['win'].mean()*100, 1), avgR_plan=round(x['Ra'].mean(), 3),
                avgR_trend=round(x['Rb'].mean(), 3), win_trend=round((x['Rb'] > 0).mean()*100, 1),
                p90_trend=round(x['Rb'].quantile(.9), 2), per_year=round(len(x)/8.9))
X = T[T['mode'] == 'close'].copy()
X['noise'] = (X.kind == 'inverse_hs') | ((X.kind == 'bull_flag') & (X.tf == 'daily'))
V = X.volx >= 1.5; C = X.clv >= 0.7; A3 = X.adr >= 3.5; RS = X.rsv >= 10; NO = ~X.noise
rows = [summ(X, 'close entries, all'), summ(X[NO], 'drop inverse H&S + daily flags'),
        summ(X[V], 'vol>=1.5x'), summ(X[V & C], 'vol>=1.5x + close in top 30%'),
        summ(X[V & C & NO], 'vol+strong close, no noise patterns'),
        summ(X[V & C & NO & A3], '... + ADR>=3.5%'), summ(X[V & C & NO & A3 & RS], '... + RS vs SPY>=10pts'),
        summ(X[V & C & NO & RS], 'vol+close+no-noise+RS'),
        summ(X[V & C & NO & A3 & X.gate], 'vol+close+no-noise+ADR + gate ON'), summ(X[V & C & NO & A3 & ~X.gate], 'vol+close+no-noise+ADR + gate OFF'),
        summ(X[(X.volx >= 2) & C & NO & A3], 'vol>=2x + close + no-noise + ADR'),
        summ(X[V & C & NO & A3 & X.notext & X.streak_ok], 'vol+close+no-noise+ADR + not ext + <=3 up days'),
        summ(X[V & C & NO & A3 & ~(X.notext & X.streak_ok)], 'vol+close+no-noise+ADR but extended/chasing')]
pd.set_option('display.width', 250)
print(pd.DataFrame(rows).set_index('filter').to_string())
best = X[V & C & NO & A3]
print('\nper year, vol+close+no-noise+ADR>=3.5 (close entries):')
print(best.groupby('yr').apply(lambda x: pd.Series(dict(n=len(x), win_3R=round(x.win.mean()*100,1), avgR_plan=round(x.Ra.mean(),2), avgR_trend=round(x.Rb.mean(),2)))).to_string())
print('\nbaseline per year (close entries, all):')
print(X.groupby('yr').apply(lambda x: pd.Series(dict(n=len(x), avgR_plan=round(x.Ra.mean(),2), avgR_trend=round(x.Rb.mean(),2)))).T.to_string())
print('\nby pattern within vol>=1.5x & strong close (close entries):')
print(X[V & C].groupby(['kind', 'tf']).apply(lambda x: pd.Series(dict(n=len(x), win_3R=round(x.win.mean()*100,1), avgR_plan=round(x.Ra.mean(),2), avgR_trend=round(x.Rb.mean(),2)))).to_string())
