import sys, io, json
import pandas as pd
d = sys.argv[1]
sp = pd.read_html(io.StringIO(open(d + '/sp500.html', encoding='utf-8').read()), flavor='lxml')
spt = None
for t in sp:
    cols = [str(c) for c in t.columns]
    if any('Symbol' in c for c in cols) and len(t) > 400:
        spt = t; break
ndx = pd.read_html(io.StringIO(open(d + '/ndx_list.html', encoding='utf-8').read()), flavor='lxml')
ndt = None
for t in ndx:
    cols = [str(c) for c in t.columns]
    if any(c in ('Ticker', 'Symbol') for c in cols) and 90 <= len(t) <= 110:
        ndt = t; break
sp_syms = [str(s).replace('.', '-') for s in spt['Symbol']]
col = 'Ticker' if 'Ticker' in ndt.columns else 'Symbol'
nd_syms = [str(s).replace('.', '-') for s in ndt[col]]
sectors = {}
if 'GICS Sector' in spt.columns:
    for s, sec in zip(spt['Symbol'], spt['GICS Sector']):
        sectors[str(s).replace('.', '-')] = sec
json.dump({'sp500': sp_syms, 'ndx': nd_syms, 'sectors': sectors}, open(d + '/constituents.json', 'w'))
print(len(sp_syms), len(nd_syms), sp_syms[:5], nd_syms[:5])
