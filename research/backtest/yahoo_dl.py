import sys, json, time, os, urllib.request, urllib.error, concurrent.futures as cf, datetime as dt
out_dir = sys.argv[1]; start = sys.argv[2]; syms = sys.argv[3].split(',')
p1 = int(dt.datetime.strptime(start, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc).timestamp())
p2 = int(time.time()) + 86400
UA = 'Mozilla/5.0'
def get(sym):
    path = os.path.join(out_dir, sym.replace('^', '_') + '.json')
    if os.path.exists(path) and os.path.getsize(path) > 200:
        return sym, 'cached'
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1={p1}&period2={p2}&interval=1d&events=split'
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                d = json.load(r)
            res = d['chart']['result'][0]
            ts = res.get('timestamp') or []
            q = res['indicators']['quote'][0]
            adj = (res['indicators'].get('adjclose') or [{}])[0].get('adjclose')
            gmt = res['meta'].get('gmtoffset', 0)
            rows = []
            for i, t in enumerate(ts):
                o, h, l, c, v = q['open'][i], q['high'][i], q['low'][i], q['close'][i], q['volume'][i]
                if None in (o, h, l, c):
                    continue
                day = dt.datetime.fromtimestamp(t + gmt, dt.timezone.utc).strftime('%Y-%m-%d')
                rows.append([day, o, h, l, c, v or 0])
            json.dump(rows, open(path, 'w'))
            return sym, len(rows)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return sym, 'missing'
            time.sleep(2 + attempt * 3)
        except Exception as e:
            time.sleep(2 + attempt * 3)
    return sym, 'failed'
import urllib.parse
with cf.ThreadPoolExecutor(max_workers=4) as ex:
    res = list(ex.map(get, syms))
bad = [r for r in res if not isinstance(r[1], int) and r[1] != 'cached']
print('done', len(res), 'bad', bad[:40])
