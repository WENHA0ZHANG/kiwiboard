import os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, fwd_maxdd, fwd_ret, episodes
SP = WORK
D = pd.read_pickle(os.path.join(SP, 'D2.pkl')); c = D['c']; idx = D.index
br = pd.read_csv(os.path.join(SP, 'breadth.csv'), index_col=0, parse_dates=True).reindex(idx)
nd = D['ndxc']
D['n_dd40'] = fwd_maxdd(nd, 40); D['n_r20'] = fwd_ret(nd, 20); D['n_r60'] = fwd_ret(nd, 60)
near = c >= D['hi252'] * 0.98
S = {
 'ndx20<20': br['ndx20'] < 20,
 'ndx20<10': br['ndx20'] < 10,
 'thrust <25 -> >75 in 10d': (br['ndx20'] > 75) & (br['ndx20'].rolling(10).min() < 25),
 'ndx20>80': br['ndx20'] > 80,
 'spx near hi & %>50dma<55': near & (br['spx50'] < 55),
 'spx near hi & %>200dma<60': near & (br['spx200'] < 60),
 'spx50 breadth falls 20pts/15d near hi': near & (br['spx50'].rolling(15).max() - br['spx50'] >= 20),
}
m = (idx >= '2016-03-01') & D['dd60'].notna() & D['n_dd40'].notna()
rows = []
for k, s in S.items():
    s = s.fillna(False) & m
    ep, _ = episodes(s)
    rows.append(dict(signal=k, days=int(s.sum()), eps=ep,
        spx_p5=round((D.loc[s,'dd40']<=-.05).mean()*100,1), spx_base5=round((D.loc[m,'dd40']<=-.05).mean()*100,1),
        ndx_p5=round((D.loc[s,'n_dd40']<=-.05).mean()*100,1), ndx_base5=round((D.loc[m,'n_dd40']<=-.05).mean()*100,1),
        ndx_r20=round(D.loc[s,'n_r20'].mean()*100,2), ndx_b_r20=round(D.loc[m,'n_r20'].mean()*100,2),
        ndx_r60=round(D.loc[s,'n_r60'].mean()*100,2), ndx_b_r60=round(D.loc[m,'n_r60'].mean()*100,2),
        ndx_win60=round((D.loc[s,'n_r60']>0).mean()*100,1), ndx_bwin60=round((D.loc[m,'n_r60']>0).mean()*100,1)))
pd.set_option('display.width', 250)
print(pd.DataFrame(rows).set_index('signal').to_string())
# 2026 path of the stress inputs around the October top
cols = ['c', 'dgs10', 'dfii10', 'move', 'baa', 'skew', 'vix', 'stress']
x = D.loc['2026-08-01':'2026-11-27', cols].copy()
x['d10y_20d'] = D['dgs10'].diff(20).loc[x.index]; x['dreal_20d'] = D['dfii10'].diff(20).loc[x.index]
x['ndx20'] = br['ndx20'].loc[x.index]; x['spx50b'] = br['spx50'].loc[x.index]
x['trend'] = np.where((D['c'] < D['e21']) & (D['e8'] < D['e21']), 'BREAK', np.where(D['c'] > D['e21'], 'up', 'mixed'))[[idx.get_loc(d) for d in x.index]]
print(x.iloc[::3].round(2).to_string())
