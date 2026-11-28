"""Watchlist v2: trade every Special Focus name (focus_score >= threshold) with its own entry rule.

Input: the walk.cjs output of the v2 analysis bundle (work/bt/v2/sig_*.jsonl).
  EP gap            buy at the gap day's close (the page flags it while it forms)
  tight / 21 EMA    buy-stop above the signal day's high, next session only
  base              buy-stop at the pivot within 5 sessions, structural stop
Stops come from the production plan (signal-day low, or pivot - 1 ATR, at most
7-8%). Exits: plan = +3R / -1R / 30 days; trend = breakeven after +2R, close
below EMA21, 60 days. Only liquid names (production rule), one trade at a time.
"""
import os, sys, glob, warnings
import numpy as np, pandas as pd
from bt_common import load_bars, features, simulate, SP
warnings.filterwarnings('ignore')
DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SP, 'bt', 'v2')
sig = pd.concat([pd.read_json(p, lines=True) for p in sorted(glob.glob(os.path.join(DIR, 'sig_*.jsonl')))], ignore_index=True)
sig = sig.sort_values(['s', 'i']).reset_index(drop=True)
PRI = {'EP': 3, 'TIGHT_PB': 2, 'PB21': 1}
days_total = sig['d'].nunique()


def trades_for(th):
    out = []
    for sym, g in sig[sig.fs >= th].groupby('s'):
        b = load_bars(sym); f = features(b); n = len(b['c'])
        busy = -1
        for r in g.itertuples(index=False):
            t = r.i
            if t <= busy or t + 2 >= n:
                continue
            su = [x for x in (r.su if isinstance(r.su, list) else []) if not (x['c'] == 'PB21' and x['w'])]
            su.sort(key=lambda x: -PRI[x['c']])
            j = None; at_close = False
            if su:
                x = su[0]
                if x['c'] == 'EP':
                    etype = 'EP gap (close)'; j = t; at_close = True
                    entry = b['c'][t]; stop = max(b['l'][t], entry * 0.92)
                else:
                    etype = 'tight pullback' if x['c'] == 'TIGHT_PB' else '21 EMA pullback'
                    if b['h'][t + 1] > x['tr']:
                        j = t + 1; entry = max(x['tr'], b['o'][j]); stop = x['sl']
            elif r.pk == 'breakout' and r.pv == r.pv and r.pv:
                etype = 'base breakout'
                P = float(r.pv)
                for k in range(t + 1, min(n, t + 6)):
                    if b['h'][k] >= P:
                        j = k; entry = max(P, b['o'][k]); stop = float(r.pst); break
            if j is None or not (stop < entry) or (entry - stop) / entry > 0.10:
                continue
            ra, ja = simulate(b, f, j, entry, stop, 'A', enter_at_close=at_close)
            rb, jb = simulate(b, f, j, entry, stop, 'B', enter_at_close=at_close)
            if ra is None:
                continue
            busy = max(ja, jb)
            out.append(dict(sym=sym, d=b['d'][j], yr=int(b['d'][j][:4]), etype=etype, fs=r.fs, Ra=ra, Rb=rb,
                            win=ra >= 2.99, risk_pct=(entry - stop) / entry * 100, stress=r.st))
    return pd.DataFrame(out)


def summ(x):
    return pd.Series(dict(n=len(x), per_year=round(len(x) / 8.9), win_3R=round(x.win.mean() * 100, 1),
                          avgR_plan=round(x.Ra.mean(), 3), avgR_trend=round(x.Rb.mean(), 3),
                          win_trend=round((x.Rb > 0).mean() * 100, 1), risk_pct=round(x.risk_pct.mean(), 1)))


pd.set_option('display.width', 250)
for th in (3, 4, 5):
    focus = sig[sig.fs >= th]
    names_per_day = len(focus) / days_total
    T = trades_for(th)
    print(f'\n=== focus_score >= {th}: {names_per_day:.2f} focus names a day across {sig.s.nunique()} stocks; '
          f'{len(T) / days_total:.2f} trades a day ===')
    print(summ(T).to_string())
    print(T.groupby('etype').apply(summ).to_string())
    T['half'] = np.where(T.yr <= 2022, '2018-2022', '2023-2026')
    print(T.groupby('half').apply(summ)[['n', 'win_3R', 'avgR_plan', 'avgR_trend']].to_string())
    print(T.pivot_table(index='etype', columns='yr', values='Rb', aggfunc='mean').round(2).to_string())
    T.to_pickle(os.path.join(DIR, f'focus_trades_{th}.pkl'))
