import json, os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo
SP = WORK
cons = json.load(open(os.path.join(SP, 'data', 'wiki', 'constituents.json')))
def breadth(members, n=20, kind='sma'):
    above = []; valid = []
    for s in members:
        try: df = yahoo(s, 'stocks')
        except Exception: continue
        c = df['close']
        ma = c.rolling(n).mean() if kind == 'sma' else c.ewm(span=n, adjust=False).mean()
        above.append((c > ma).astype(float).where(ma.notna()))
    m = pd.concat(above, axis=1)
    return (m.mean(axis=1) * 100).dropna(), m.notna().sum(axis=1)
if __name__ == '__main__':
    b20, cnt = breadth(cons['ndx'], 20)
    b50, _ = breadth(cons['ndx'], 50)
    sb20, scnt = breadth(cons['sp500'], 20)
    sb50, _ = breadth(cons['sp500'], 50)
    sb200, _ = breadth(cons['sp500'], 200)
    out = pd.DataFrame({'ndx20': b20, 'ndx50': b50, 'spx20': sb20, 'spx50': sb50, 'spx200': sb200, 'ndx_n': cnt, 'spx_n': scnt})
    out.to_csv(os.path.join(SP, 'breadth.csv'))
    rows = json.load(open(os.path.join(SP, 'data', 'd1_obs.json')))[0]['results']
    bc = pd.Series({pd.Timestamp(r['as_of']): r['value'] for r in rows if r['indicator_id'] == 'nasdaq100_above_20d_ma'}).sort_index()
    j = pd.concat([bc.rename('barchart'), out['ndx20']], axis=1).dropna()
    print('overlap days', len(j), 'corr', round(j.corr().iloc[0, 1], 3), 'mean abs diff', round((j['barchart'] - j['ndx20']).abs().mean(), 1))
    print(j.iloc[::10].round(1).to_string())
    print(out.tail(8).round(1).to_string())
