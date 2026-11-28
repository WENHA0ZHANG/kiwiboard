import os, sys, pickle
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, fred, ema, episodes
SP = WORK
D = pd.read_pickle(os.path.join(SP, 'D.pkl')); c = D['c']; idx = D.index
lag = lambda s, k: s.shift(k)        # publication lag in trading days
nf = lag(D['nfci'], 5); baa = lag(D['baa'], 1); rr = lag(D['dfii10'], 1); n10 = lag(D['dgs10'], 1)
mv = D['move']
S = {
 'nfci +0.10/4w (lag 1w)': nf.diff(20) >= 0.10,
 'nfci +0.05/4w (lag 1w)': nf.diff(20) >= 0.05,
 'move>=120': mv >= 120,
 'move>=110': mv >= 110,
 'move +25%/20d': mv / mv.shift(20) >= 1.25,
 'real10y +30bp/20d (lag1)': rr.diff(20) >= 0.30,
 'real10y +25bp/20d (lag1)': rr.diff(20) >= 0.25,
 'nom10y +40bp/20d (lag1)': n10.diff(20) >= 0.40,
 'baa +20bp/20d (lag1)': baa.diff(20) >= 0.20,
 'baa +15bp/20d (lag1)': baa.diff(20) >= 0.15,
 'skew>=150': D['skew'] >= 150,
 'trend break': (c < D['e21']) & (D['e8'] < D['e21']),
}
def stats(sig, start):
    m = (idx >= start) & D['dd60'].notna(); s = sig.fillna(False) & m
    b5 = (D.loc[m, 'dd40'] <= -.05).mean(); b10 = (D.loc[m, 'dd60'] <= -.10).mean()
    if not s.any(): return {}
    ep, _ = episodes(s)
    return dict(days=int(s.sum()), eps=ep, p5=round((D.loc[s,'dd40']<=-.05).mean()*100,1), base5=round(b5*100,1),
                p10=round((D.loc[s,'dd60']<=-.10).mean()*100,1), base10=round(b10*100,1),
                r20=round(D.loc[s,'r20'].mean()*100,2), b_r20=round(D.loc[m,'r20'].mean()*100,2), r60=round(D.loc[s,'r60'].mean()*100,2), b_r60=round(D.loc[m,'r60'].mean()*100,2))
rows = []
for k, v in S.items():
    st = '2003-02-01' if ('real' in k or 'move' in k) else '1990-01-01'
    r = stats(v, st); r['signal'] = k; r['from'] = st[:4]; rows.append(r)
# composite stress count (2003+, all inputs available)
comp = (S['nfci +0.05/4w (lag 1w)'].astype(int) + S['move>=110'].astype(int) + S['real10y +25bp/20d (lag1)'].astype(int)
        + S['baa +15bp/20d (lag1)'].astype(int) + S['skew>=150'].astype(int))
for k in (1, 2, 3):
    r = stats(comp >= k, '2003-02-01'); r['signal'] = f'stress count>={k}'; r['from'] = '2003'; rows.append(r)
for k in (1, 2):
    sig = (comp >= k) & S['trend break']
    r = stats(sig, '2003-02-01'); r['signal'] = f'stress>={k} & trend break'; r['from'] = '2003'; rows.append(r)
    sig = (comp >= k) & ~S['trend break']
    r = stats(sig, '2003-02-01'); r['signal'] = f'stress>={k} & trend ok'; r['from'] = '2003'; rows.append(r)
pd.set_option('display.width', 250)
print(pd.DataFrame(rows).set_index('signal').to_string())
D['stress'] = comp
D.to_pickle(os.path.join(SP, 'D2.pkl'))
# early-warning coverage: corrections >=10% since 2003
peaks = []
hi = c.cummax(); in_dd = False
for i, d in enumerate(idx):
    if d < pd.Timestamp('2003-01-01'): continue
    dd = c.iloc[i] / hi.iloc[i] - 1
    if not in_dd and dd <= -0.10:
        in_dd = True
        pk = c.iloc[:i + 1][c.iloc[:i + 1] == hi.iloc[i]].index[-1]
        hit5 = c.loc[pk:].index[(c.loc[pk:] / hi.iloc[i] - 1 <= -0.05).values][0]
        peaks.append((pk, hit5, d))
    if in_dd and c.iloc[i] >= hi.iloc[i] * 0.999: in_dd = False
print('\ncorrections >=10% since 2003 (peak, -5% date, -10% date) and which signals fired between peak-20d and the -5% date:')
for pk, h5, h10 in peaks:
    w0 = idx[max(0, idx.get_loc(pk) - 20)]
    fired = []
    for k in ('nfci +0.05/4w (lag 1w)', 'move>=110', 'real10y +25bp/20d (lag1)', 'baa +15bp/20d (lag1)', 'skew>=150', 'nom10y +40bp/20d (lag1)', 'trend break'):
        win = S[k].loc[w0:h5].fillna(False)
        if win.any(): fired.append(f"{k.split(' ')[0]}@{win[win].index[0].strftime('%m-%d')}")
    trough = c.loc[pk:].iloc[:250].min() / c.loc[pk] - 1
    print(pk.date(), h5.date(), h10.date(), f'trough {trough*100:.1f}%', ' | '.join(fired))
