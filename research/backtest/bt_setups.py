import os, sys, glob
import numpy as np, pandas as pd
from bt_common import load_bars, features, simulate, market, SP
M = market(); trades = []
syms = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(SP, 'data', 'stocks', '*.json')))
def take(name, b, f, t, j, entry, stop, n, extra=None, at_close=False):
    if stop >= entry or (entry - stop) / entry > 0.08: return None
    ra, ja = simulate(b, f, j, entry, stop, 'A', enter_at_close=at_close)
    rb, jb = simulate(b, f, j, entry, stop, 'B', enter_at_close=at_close)
    if ra is None: return None
    m = M.get(b['d'][t], {})
    trades.append(dict(setup=name, sym=b['sym'], d=b['d'][j], yr=int(b['d'][j][:4]), Ra=ra, Rb=rb, win=ra >= 2.99,
                       gate=m.get('ok', False), stress=m.get('stress', np.nan), adr=f['adr'][t], risk_pct=(entry - stop) / entry * 100,
                       rsv=f['r6m'][t] - (m.get('spy_r6m') or 0), **(extra or {})))
    return max(ja, jb)
for sym in syms:
    b = load_bars(sym); b['sym'] = sym; f = features(b); n = len(b['c'])
    c, h, l, o, v = b['c'], b['h'], b['l'], b['o'], b['v']
    e8, e21, e50 = f['e8'], f['e21'], f['e50']
    atrp = f['atr'] / c * 100
    start = int(np.searchsorted(b['d'], '2018-01-02'))
    busy = {k: -1 for k in ('pull21', 'tight', 'unr', 'ep_close', 'ep_next')}
    for t in range(max(start, 260), n - 2):
        liquid = f['dv20'][t] >= 2e7 and c[t] >= 10
        if not liquid: continue
        up = e8[t] > e21[t] > e50[t] and e50[t] > e50[t - 10] and c[t] > e50[t]
        # S1: pullback to a rising 21 EMA on light volume, buy above the pullback day's high
        if t > busy['pull21'] and up and f['r6m'][t] >= 15:
            drop = c[t] / c[t - 5:t].max() - 1
            if l[t] <= e21[t] * 1.01 and c[t] >= e21[t] * 0.98 and drop <= -1.5 * atrp[t] / 100 and v[t - 2:t + 1].mean() < f['v50'][t]:
                j = t + 1
                if h[j] > h[t]:
                    busy['pull21'] = take('EMA21 pullback', b, f, t, j, max(h[t], o[j]), l[t], n) or busy['pull21']
        # S2: leader that ran >=25% in a month, sharp drop into the rising 8/21 EMA, then a tight candle
        if t > busy['tight'] and f['r1m'][t - 5] >= 25 and f['adr'][t] >= 4 and e21[t] > e21[t - 5]:
            sharp = c[t] / c[t - 6:t].max() - 1 <= -0.08
            near = e21[t] * 0.97 <= c[t] <= e8[t] * 1.03
            tight = (h[t] - l[t]) / c[t] * 100 <= 0.6 * f['adr'][t]
            if sharp and near and tight:
                j = t + 1
                if h[j] > h[t]:
                    busy['tight'] = take('tight candle at 8/21 EMA', b, f, t, j, max(h[t], o[j]), l[t], n) or busy['tight']
        # S3: undercut a recent swing low on the day, close back above it
        if t > busy['unr'] and e21[t] > e50[t] and c[t] > f['sma200'][t]:
            sup = l[t - 25:t - 2].min()
            if l[t] < sup * 0.995 and c[t] > sup and v[t] >= 0.8 * f['v50'][t]:
                j = t + 1
                if h[j] > h[t]:
                    busy['unr'] = take('undercut & rally', b, f, t, j, max(h[t], o[j]), l[t], n) or busy['unr']
        # S4: gap >=8% on >=3x volume that holds, without a big run in the prior 6 months
        if f['v50'][t] == f['v50'][t] and o[t] >= c[t - 1] * 1.08 and v[t] >= 3 * f['v50'][t] and c[t] >= o[t] and (f['r6m'][t - 1] != f['r6m'][t - 1] or f['r6m'][t - 1] <= 30):
            if t > busy['ep_close']:
                stop = max(l[t], c[t] * 0.92)
                busy['ep_close'] = take('gap-up EP (buy at close)', b, f, t, t, c[t], stop, n, at_close=True) or busy['ep_close']
            if t > busy['ep_next']:
                j = t + 1
                if h[j] > h[t]:
                    entry = max(h[t], o[j]); stop = max(l[t], entry * 0.92)
                    busy['ep_next'] = take('gap-up EP (buy above day-1 high)', b, f, t, j, entry, stop, n) or busy['ep_next']
T = pd.DataFrame(trades); T.to_pickle(os.path.join(SP, 'bt', 'setup_trades.pkl'))
def summ(x):
    return pd.Series(dict(n=len(x), per_year=round(len(x)/8.9), win_3R=round(x.win.mean()*100, 1), avgR_plan=round(x.Ra.mean(), 3),
                          avgR_trend=round(x.Rb.mean(), 3), win_trend=round((x.Rb > 0).mean()*100, 1), risk_pct=round(x.risk_pct.mean(), 1)))
pd.set_option('display.width', 250)
print(T.groupby('setup').apply(summ).to_string())
print('\nmarket gate split:')
print(T.groupby(['setup', 'gate']).apply(summ)[['n', 'win_3R', 'avgR_plan', 'avgR_trend']].to_string())
print('\nstress split (count>=2 vs <2):')
T['stress2'] = T.stress.fillna(0) >= 2
print(T.groupby(['setup', 'stress2']).apply(summ)[['n', 'win_3R', 'avgR_plan', 'avgR_trend']].to_string())
print('\nper year avgR_trend:')
print(T.pivot_table(index='setup', columns='yr', values='Rb', aggfunc='mean').round(2).to_string())
