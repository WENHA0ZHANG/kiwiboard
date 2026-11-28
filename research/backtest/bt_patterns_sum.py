import os, sys
from paths import WORK
import numpy as np, pandas as pd
SP = WORK
T = pd.read_pickle(os.path.join(SP, 'bt', 'pattern_trades.pkl'))

def summ(x, label):
    if not len(x): return dict(filter=label, n=0)
    return dict(filter=label, n=len(x), win_3R=round(x['win'].mean() * 100, 1), avgR_plan=round(x['Ra'].mean(), 3),
                avgR_trend=round(x['Rb'].mean(), 3), win_trend=round((x['Rb'] > 0).mean() * 100, 1), per_year=round(len(x) / 8.9))
for mode in ('stop', 'close'):
    X = T[T['mode'] == mode]
    rows = [summ(X, 'all patterns (baseline)'), summ(X[X.fs >= 4], 'Special Focus (score>=4)'),
            summ(X[X.gate], '+ market gate (SPY>21EMA & 8>21)'), summ(X[~X.gate], 'market gate OFF'),
            summ(X[X.gate & X.lead], 'gate + 6m>=20%'), summ(X[X.gate & X.rs], 'gate + RS vs SPY>=10pts'),
            summ(X[X.gate & X.lead & X.notext & X.streak_ok], 'gate + lead + not extended + <=3 up days'),
            summ(X[X.gate & X.lead & X.notext & X.streak_ok & X.liquid], '... + liquid ($20M, >$10)'),
            summ(X[X.gate & X.lead & X.notext & X.streak_ok & X.liquid & X.stacked], '... + EMA 8>21>50'),
            summ(X[X.gate & X.lead & X.notext & X.streak_ok & X.liquid & X.stacked & (X.stress.fillna(0) < 2)], '... + market stress<2'),
            summ(X[X.vol15], 'breakout vol>=1.5x'), summ(X[X.gate & X.lead & X.notext & X.streak_ok & X.vol15], 'gate+lead+notext+streak+vol1.5x'),
            summ(X[X.adr4], 'ADR>=4%'), summ(X[X.gate & X.lead & X.adr4], 'gate+lead+ADR>=4%')]
    print(f'\n=== entry mode: {mode} ===')
    print(pd.DataFrame(rows).set_index('filter').to_string())
X = T[T['mode'] == 'stop']
print('\nby pattern (buy-stop entries, all):')
print(X.groupby(['kind', 'tf']).apply(lambda x: pd.Series(dict(n=len(x), win_3R=round(x.win.mean()*100,1), avgR_plan=round(x.Ra.mean(),3), avgR_trend=round(x.Rb.mean(),3)))).to_string())
