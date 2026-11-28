const fs = require('fs'); const path = require('path');
// Walk forward over every stock: run the production computeMetrics on the
// trailing 2-year window each day and record the days that have a pattern,
// a setup or a focus score. Bundle the production code first (see README):
// work/analysis.cjs. KB_STRESS may point at a {date: stress count} JSON
// (made by stress_json.py) so the watchlist v2 stress rule is replayed too.
const { computeMetrics } = require(process.env.KB_ANALYSIS || path.join(__dirname, 'work', 'analysis.cjs'));
const stressByDate = process.env.KB_STRESS ? JSON.parse(fs.readFileSync(process.env.KB_STRESS)) : {};
const [dir, outFile, shard, nShards] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5]];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().filter((_, k) => k % nShards === shard);
const out = fs.createWriteStream(outFile);
for (const f of files) {
  const sym = f.replace('.json', '');
  const rows = JSON.parse(fs.readFileSync(path.join(dir, f)));
  const bars = rows.map(r => ({ date: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  for (let t = 0; t < bars.length; t++) {
    if (bars[t].date < '2018-01-02') continue;
    const w = bars.slice(Math.max(0, t - 503), t + 1);
    if (w.length < 260) continue;
    const stress = stressByDate[bars[t].date];
    const m = computeMetrics(sym, w, { lastBarComplete: true, stress: stress == null ? null : stress });
    const setups = m.setups || [];
    if (!(m.pattern && m.pattern.kind) && !setups.length && !(m.focus_score > 0)) continue;
    out.write(JSON.stringify({
      s: sym, i: t, d: bars[t].date, k: m.pattern.kind, tf: m.pattern.timeframe, pv: m.pivot,
      fs: m.focus_score, rs: m.focus_reasons.join(' '), sp: m.stop_pct, adr: m.adr_pct, atr: m.atr, rsi: m.rsi,
      ext: m.extended, vr: m.vol_ratio, c1m: m.chg_1m_pct, c6m: m.chg_6m_pct, px: m.price, nm: m.pattern_matches.length,
      pk: m.plan_kind, pe: m.entry, pst: m.stop, st: stress == null ? null : stress,
      su: setups.map(x => ({ c: x.code, k: x.kind, tr: x.trigger, sl: x.stop, w: x.stress_warning })),
    }) + '\n');
  }
}
out.end(() => console.log('shard', shard, 'files', files.length));
