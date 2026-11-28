"""Replay the production Poor2Rich score day by day from the D1 history."""
import json, os, sys
from paths import WORK
import numpy as np, pandas as pd
from mkt import yahoo, fred, ema
SP = WORK
W = dict(vix=1.5, us_high_yield_spread=1.5, sp500_pe_ratio=1.2, cnn_fear_greed_index=1.0, cnn_put_call_options=1.0,
         nasdaq100_above_20d_ma=1.0, yc_10y_2y=1.0, bofa_bull_bear=0.7, sp500_rsi=0.7, nasdaq100_pe_ratio=0.7, cboe_skew=0.6)
def tier(i, v, inv):
    if i == 'vix': return 3 if v >= 40 else 2 if v >= 30 else 1 if v > 25 else -2 if v < 12 else -1 if v < 14 else 0
    if i == 'cnn_fear_greed_index': return 3 if v <= 10 else 2 if v <= 20 else 1 if v <= 25 else -2 if v >= 85 else -1 if v >= 75 else 0
    if i == 'cnn_put_call_options': return 3 if v >= 1.2 else 2 if v >= 1.05 else 1 if v >= .95 else -2 if v < .5 else -1 if v < .55 else 0
    if i == 'bofa_bull_bear': return 2 if v <= -30 else 1 if v <= -20 else -2 if v >= 30 else -1 if v >= 20 else 0
    if i == 'sp500_rsi': return 2 if v < 25 else 1 if v < 30 else -2 if v > 80 else -1 if v > 70 else 0
    if i == 'us_high_yield_spread':
        bp = v if v > 30 else v * 100
        return 3 if bp >= 700 else 2 if bp >= 550 else 1 if bp >= 400 else -2 if bp <= 250 else -1 if bp <= 270 else 0
    if i == 'nasdaq100_above_20d_ma': return 2 if v < 10 else 1 if v < 20 else -2 if v > 90 else -1 if v > 80 else 0
    if i == 'sp500_pe_ratio': return 2 if v <= 22 else 1 if v <= 25 else -2 if v >= 35 else -1 if v >= 31 else 0
    if i == 'nasdaq100_pe_ratio': return 2 if v <= 22 else 1 if v <= 26 else -2 if v >= 34 else -1 if v >= 30 else 0
    if i == 'cboe_skew': return -2 if v >= 160 else -1 if v >= 155 else 2 if v <= 130 else 1 if v <= 135 else 0
    if i == 'yc_10y_2y': return -1 if (inv and -0.05 <= v <= 0.6) else 0
    return 0
def load_obs(breadth_override=None):
    rows = json.load(open(os.path.join(SP, 'data', 'd1_obs.json')))[0]['results']
    df = pd.DataFrame(rows); df['as_of'] = pd.to_datetime(df['as_of'])
    wide = df.pivot_table(index='as_of', columns='indicator_id', values='value', aggfunc='last').sort_index()
    if breadth_override is not None:
        wide = wide.drop(columns=['nasdaq100_above_20d_ma'], errors='ignore').join(breadth_override.rename('nasdaq100_above_20d_ma'), how='outer')
    return wide
def replay(wide, days, max_age=None):
    yc = fred('T10Y2Y')
    out = []
    for d in days:
        snap = wide[wide.index <= d]
        row = {'date': d}; pts = {}
        for col in W:
            if col not in snap: continue
            s = snap[col].dropna()
            if s.empty: continue
            if max_age is not None and (d - s.index[-1]).days > max_age: continue
            v = s.iloc[-1]
            inv = bool((yc[(yc.index > d - pd.Timedelta(days=720)) & (yc.index <= d)] < 0).any())
            t = tier(col, v, inv)
            pts[col] = round(t * W[col], 2); row[col] = v
        buy = sum(p for p in pts.values() if p > 0); risk = -sum(p for p in pts.values() if p < 0)
        row.update(score=round(buy - risk, 2), buy=round(buy, 2), risk=round(risk, 2),
                   fired=' '.join(f"{k.split('_')[0]}{v:+.1f}" for k, v in pts.items() if v))
        out.append(row)
    return pd.DataFrame(out).set_index('date')
if __name__ == '__main__':
    spx = yahoo('^GSPC')['close']
    days = spx[(spx.index >= '2025-05-01')].index
    wide = load_obs()
    r = replay(wide, days)
    r['spx'] = spx.reindex(r.index)
    r['dd'] = (r['spx'] / r['spx'].cummax() - 1) * 100
    pd.set_option('display.width', 200); pd.set_option('display.max_colwidth', 80)
    weekly = r[r.index.weekday == 4]
    print(weekly[['spx', 'dd', 'score', 'buy', 'risk', 'fired']].round(2).to_string())
    r.to_csv(os.path.join(SP, 'regime_replay.csv'))
