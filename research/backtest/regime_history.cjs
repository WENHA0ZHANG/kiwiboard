// Usage (data in $KB_RESEARCH_DIR, see README.md):
//   npx esbuild cloudflare/worker/src/lib/regime.ts --bundle --platform=node --format=cjs --outfile=$KB_RESEARCH_DIR/bt/regime_live.cjs
//   node research/backtest/regime_history.cjs $KB_RESEARCH_DIR 2025-05-01 2026-11-27
//   npx wrangler d1 execute poor-trader-db --remote --file $KB_RESEARCH_DIR/regime_history.sql
// Replays the live computeMarketRegime (bundled from src/lib/regime.ts) for
// every S&P session from START, and writes SQL that backfills
//   market_regime  (the score, one row per session)
//   the six v2 stress series (so their charts have history too)
// with INSERT OR IGNORE, so rows the Worker already wrote are kept.
const fs = require('fs'); const path = require('path');
const SP = process.argv[2]; const START = process.argv[3] || '2025-05-01'; const END = process.argv[4] || '2026-11-27';
const { computeMarketRegime } = require(path.join(SP, 'bt', 'regime_live.cjs'));
const obs = JSON.parse(fs.readFileSync(path.join(SP, 'data', 'd1_obs.json')))[0].results;
const by = {};
for (const o of obs) { if (o.indicator_id === 'bofa_bull_bear' || o.indicator_id === 'nasdaq100_above_20d_ma') continue; (by[o.indicator_id] ??= []).push(o); }
for (const k in by) by[k].sort((a, b) => a.as_of < b.as_of ? -1 : 1);
const csv = (f) => fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((p) => p[1] && p[1] !== '.' && p[1] !== '').map((p) => ({ as_of: p[0], value: +p[1] }));
const fred = (id) => csv(path.join(SP, 'data', 'fred', id + '.csv'));
const real = fred('DFII10'), nom = fred('DGS10'), nfci = fred('NFCI'), hy = fred('BAMLH0A0HYM2').map((r) => ({ as_of: r.as_of, value: Math.round(r.value * 100), unit: 'bp' }));
const yj = (f) => JSON.parse(fs.readFileSync(path.join(SP, 'data', 'yahoo', f))).map((r) => ({ as_of: r[0], value: r[4] }));
const move = yj('_MOVE.json'), spx = yj('_GSPC.json');
const offHigh = spx.map((r, i) => {
  const high = Math.max(...spx.slice(Math.max(0, i - 251), i + 1).map((x) => x.value));
  return { as_of: r.as_of, value: Math.round((r.value / high - 1) * 10000) / 100,
    meta: { close: r.value, high_252d: high, chg_6m_pct: i >= 126 ? Math.round((r.value / spx[i - 126].value - 1) * 10000) / 100 : null } };
});
const br = fs.readFileSync(path.join(SP, 'breadth.csv'), 'utf8').trim().split(/\n/); const hdr = br[0].split(',');
const ndx20 = [], spx50 = [];
for (const l of br.slice(1)) { const p = l.split(','); const d = p[0]; const a = p[hdr.indexOf('ndx20')], b = p[hdr.indexOf('spx50')]; if (a) ndx20.push({ as_of: d, value: +a }); if (b) spx50.push({ as_of: d, value: Math.round(+b * 100) / 100, members: +p[hdr.indexOf('spx_n')] }); }
by.nasdaq100_above_20d_ma = ndx20.map((r) => ({ indicator_id: 'nasdaq100_above_20d_ma', as_of: r.as_of, value: r.value, unit: 'percent' }));
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const upto = (rows, d, strict) => rows.filter((r) => strict ? r.as_of < d : r.as_of <= d);
const yc = fred('T10Y2Y');
const days = spx.map((r) => r.as_of).filter((d) => d >= START && d <= END);
const q = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const rows = [];   // [id, as_of, value, unit, source, meta]
const out = [];
for (const d of days) {
  const latest = {};
  for (const [id, rs] of Object.entries(by)) { const u = upto(rs, d); if (u.length) latest[id] = { ...u[u.length - 1], indicator_id: id, unit: u[u.length - 1].unit ?? 'x', source: 'replay', inserted_at: d }; }
  const cut = addDays(d, -130);
  const win = (rs) => rs.filter((r) => r.as_of >= cut);
  const history = {
    real_yield_10y: win(upto(real, d, true)), ust_10y: win(upto(nom, d, true)), us_high_yield_spread: win(upto(hy, d, true)),
    nfci: win(upto(nfci, addDays(d, -7))), move_index: win(upto(move, d)), cboe_skew: win(upto(by.cboe_skew, d)),
    sp500_above_50d_ma: win(upto(spx50, d)), sp500_off_high: win(upto(offHigh, d)),
  };
  const inv = yc.some((r) => r.as_of > addDays(d, -720) && r.as_of <= d && r.value < 0);
  const g = computeMarketRegime(latest, history, inv, new Date(d + 'T23:00:00Z'));
  out.push([d, g.score, g.label, g.buy_points, g.stress_points]);
  rows.push(['market_regime', d, g.score, 'index', 'kiwiboard', { label: g.label }]);
}
const inRange = (r) => r.as_of >= START && r.as_of <= END;
for (const r of real.filter(inRange)) rows.push(['real_yield_10y', r.as_of, r.value, 'percent', 'FRED:DFII10', null]);
for (const r of nom.filter(inRange)) rows.push(['ust_10y', r.as_of, r.value, 'percent', 'FRED:DGS10', null]);
for (const r of nfci.filter(inRange)) rows.push(['nfci', r.as_of, r.value, 'index', 'FRED:NFCI', null]);
for (const r of move.filter(inRange)) rows.push(['move_index', r.as_of, Math.round(r.value * 100) / 100, 'index', 'Yahoo:^MOVE', null]);
for (const r of offHigh.filter(inRange)) rows.push(['sp500_off_high', r.as_of, r.value, 'percent', 'Yahoo:^GSPC (computed)', r.meta]);
for (const r of spx50.filter(inRange)) rows.push(['sp500_above_50d_ma', r.as_of, r.value, 'percent', 'Yahoo (computed)', { method: '% of S&P 500 members closing above their 50-day SMA', members: r.members }]);
const sql = [];
for (let i = 0; i < rows.length; i += 50) {
  const chunk = rows.slice(i, i + 50).map(([id, d, v, u, s, m]) => `(${q(id)},${q(d)},${q(v)},${q(u)},${q(s)},${q(m ? JSON.stringify(m) : null)},${q(d + ' 23:00:00Z')})`);
  sql.push(`INSERT OR IGNORE INTO observations (indicator_id, as_of, value, unit, source, meta_json, inserted_at) VALUES\n${chunk.join(',\n')};`);
}
fs.writeFileSync(path.join(SP, 'regime_history.sql'), sql.join('\n') + '\n');
const count = {}; for (const r of rows) count[r[0]] = (count[r[0]] || 0) + 1;
console.log('rows', count);
console.log('last sessions:'); for (const o of out.slice(-6)) console.log(o.join('  '));
const bands = {}; for (const o of out) bands[o[2]] = (bands[o[2]] || 0) + 1; console.log('bands', bands);
console.log('min', Math.min(...out.map((o) => o[1])), 'max', Math.max(...out.map((o) => o[1])));
for (const d of ['2025-05-01', '2025-10-10', '2026-03-30', '2026-11-24']) { const o = out.find((x) => x[0] >= d); console.log(o.join('  ')); }
