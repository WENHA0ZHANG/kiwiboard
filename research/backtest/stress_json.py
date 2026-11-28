"""Write the daily market-stress count (risk_study2.py) as {date: count} JSON for walk.cjs."""
import os, json
from paths import WORK
import pandas as pd
D = pd.read_pickle(os.path.join(WORK, 'D2.pkl'))
s = D['stress'].dropna()
out = {d.strftime('%Y-%m-%d'): int(v) for d, v in s.items()}
json.dump(out, open(os.path.join(WORK, 'stress.json'), 'w'))
print(len(out), 'days;', 'share with stress >= 2:', round((s >= 2).mean() * 100, 1), '%')
