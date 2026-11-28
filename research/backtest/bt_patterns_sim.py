import os, sys, json, glob
import numpy as np, pandas as pd
from bt_common import load_bars, features, simulate, market, SP
sig = pd.concat([pd.read_json(p, lines=True) for p in sorted(glob.glob(os.path.join(SP, 'bt', 'sig_*.jsonl')))], ignore_index=True)
sig = sig.sort_values(['s', 'i']).reset_index(drop=True)
M = market(); trades = []
for sym, g in sig.groupby('s'):
    b = load_bars(sym); f = features(b); n = len(b['c'])
    for mode in ('stop', 'close'):
        busy = -1
        for r in g.itertuples(index=False):
            t = r.i
            if t <= busy or t + 6 >= n or not r.pv or r.pv != r.pv: continue
            P = float(r.pv); ct = b['c'][t]
            if ct >= P or P > ct * 1.10: continue
            j = None
            for k in range(t + 1, min(n, t + 6)):
                if mode == 'stop' and b['h'][k] >= P: j = k; entry = max(P, b['o'][k]); break
                if mode == 'close' and b['c'][k] > P: j = k; entry = b['c'][k]; break
            if j is None: continue
            stop = entry * (1 - float(r.sp) / 100)
            ra, ja = simulate(b, f, j, entry, stop, 'A', enter_at_close=(mode == 'close'))
            rb, jb = simulate(b, f, j, entry, stop, 'B', enter_at_close=(mode == 'close'))
            if ra is None: continue
            busy = max(ja, jb)
            ctx_i = j - 1 if mode == 'stop' else j
            m = M.get(b['d'][ctx_i], {})
            trades.append(dict(sym=sym, mode=mode, d=b['d'][j], kind=r.k, tf=r.tf, fs=r.fs, nm=r.nm, sp=r.sp,
                Ra=ra, Rb=rb, win=ra >= 2.99,
                gate=m.get('ok', False), stress=m.get('stress', np.nan),
                lead=(f['r6m'][t] >= 20) if f['r6m'][t] == f['r6m'][t] else False,
                rs=(f['r6m'][t] - m.get('spy_r6m', 0) >= 10) if f['r6m'][t] == f['r6m'][t] else False,
                liquid=(f['dv20'][t] >= 2e7) and (b['c'][t] >= 10),
                adr4=f['adr'][t] >= 4,
                notext=(b['c'][ctx_i] < f['e50'][ctx_i] + 7 * f['atr'][ctx_i]) and (f['rsi'][ctx_i] < 75),
                streak_ok=f['upstreak'][j - 1] <= 3,
                vol15=(b['v'][j] >= 1.5 * f['v50'][j]) if f['v50'][j] == f['v50'][j] else False,
                stacked=(f['e8'][t] > f['e21'][t] > f['e50'][t]),
                near_hi=b['c'][t] >= 0.85 * f['hi252'][t],
                adr=f['adr'][t], rsv=f['r6m'][t] - m.get('spy_r6m', 0), volx=(b['v'][j] / f['v50'][j]) if f['v50'][j] == f['v50'][j] and f['v50'][j] > 0 else np.nan,
                clv=((b['c'][j] - b['l'][j]) / (b['h'][j] - b['l'][j])) if b['h'][j] > b['l'][j] else 0.5, yr=int(b['d'][j][:4])))
T = pd.DataFrame(trades); T.to_pickle(os.path.join(SP, 'bt', 'pattern_trades.pkl'))
