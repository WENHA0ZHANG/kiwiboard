// ── Daily market scan (Phase 4 of docs/algorithm-v2-plan.md) ────────────────
// Runs the Worker's own watchlist rules — computeMetrics (Special Focus score,
// structural stops) and detectSetups (EP gap, tight pullback, 21 EMA
// pullback) — on every S&P 500 and Nasdaq 100 stock after the US close, then:
//   1. stores the names that would make the Trade Plan in D1 `market_scan`
//      (served by /api/market-scan, shown in the Watchlist page's Market Scan);
//   2. logs Special Focus names (score ≥ 4) to `signal_log` with source
//      "scan": one open signal per symbol, names on the shared watchlist left
//      to the Worker's own log;
//   3. re-grades the open "scan" signals with the backtest's exits.
//
// esbuild bundles it from the Worker's TypeScript, so the rules exist once:
//   npx esbuild cloudflare/scan/market-scan.ts --bundle --platform=node --format=cjs \
//     --outfile=cloudflare/scan/dist/market-scan.cjs
//   node cloudflare/scan/dist/market-scan.cjs [options]
//
// Options:
//   --dry-run          no D1 at all: scan and print (stress from --stress N)
//   --sql-out FILE     also write the SQL it sends (or would send) to FILE
//   --symbols A,B      scan only these (testing)
//   --force            scan even if this session's scan is already stored
// Environment: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_TOKEN (an API token
// whose only permission is D1 edit); D1_DATABASE_ID overrides the id in
// cloudflare/worker/wrangler.toml, D1_QUERY_URL the whole API endpoint (for
// a local test double). SCAN_FORCE / SCAN_DRY_RUN = "true" act like the
// flags (used by the workflow's manual run).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics, FOCUS_MIN } from "../worker/src/lib/analysis";
import type { WatchMetrics } from "../worker/src/lib/analysis";
import { lastBarComplete, nyClock } from "../worker/src/lib/market-clock";
import {
  SCAN_KEEP_DAYS, SCAN_STATUS_KEY, SCAN_UNIVERSE, scanCandidate, sortCandidates,
} from "../worker/src/lib/market-scan";
import type { ScanCandidate, ScanStatus } from "../worker/src/lib/market-scan";
import {
  GRADE_COLS, INSERT_SIGNAL_SQL, SIGNAL_COLS, UPDATE_SIGNAL_SQL, gradeSignal, signalChanged, signalsFromMetrics,
} from "../worker/src/lib/signal-log";
import type { SignalRow } from "../worker/src/lib/signal-log";
import { fetchYahooOHLCV } from "../worker/src/lib/yahoo";
import type { YahooBar } from "../worker/src/lib/yahoo";

// ── Options ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const envOn = (name: string) => (process.env[name] ?? "").toLowerCase() === "true";

const DRY_RUN = flag("--dry-run") || envOn("SCAN_DRY_RUN");
const FORCE = flag("--force") || envOn("SCAN_FORCE");
const SQL_OUT = option("--sql-out");
const ONLY = option("--symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const STRESS_ARG = option("--stress");

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const TOKEN = process.env.CLOUDFLARE_D1_TOKEN ?? "";

/** Below this share of the universe with fresh bars, the scan isn't stored. */
const MIN_COVERAGE = 0.9;

function databaseId(): string {
  if (process.env.D1_DATABASE_ID) return process.env.D1_DATABASE_ID;
  const toml = readFileSync(join(__dirname, "..", "..", "worker", "wrangler.toml"), "utf8");
  const m = toml.match(/^\s*database_id\s*=\s*"([0-9a-f-]{36})"/m);
  if (!m) throw new Error("database_id not found in cloudflare/worker/wrangler.toml");
  return m[1];
}

// ── Yahoo: the Worker's fetchYahooOHLCV, paced ──────────────────────────────
// Yahoo answers bursts with 429. Every chart request goes through this
// wrapper: a few at a time, spaced out, and on 429 everyone waits and the
// spacing doubles (it relaxes again after a run of successes). The bars are
// still parsed by the Worker's own code.
const realFetch = globalThis.fetch.bind(globalThis);
const YAHOO_CHART = "query1.finance.yahoo.com/v8/finance/chart/";
const pace = { gapMs: 150, minGapMs: 150, maxGapMs: 3000, nextAt: 0, okStreak: 0 };
const lastStatus = new Map<string, number>();   // chart URL symbol → last HTTP status (0 = network error)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pacedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes(YAHOO_CHART)) return realFetch(input, init);
  const sym = decodeURIComponent(url.split(YAHOO_CHART)[1].split("?")[0]);
  const { cf: _cf, ...rest } = (init ?? {}) as Record<string, unknown>;
  let last: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = pace.nextAt - Date.now();
    pace.nextAt = Math.max(Date.now(), pace.nextAt) + pace.gapMs;
    if (wait > 0) await sleep(wait);
    try {
      const resp = await realFetch(url, { ...(rest as RequestInit), signal: AbortSignal.timeout(20_000) });
      lastStatus.set(sym, resp.status);
      if (resp.ok || resp.status === 404) {
        if (resp.ok && ++pace.okStreak >= 25) { pace.gapMs = Math.max(pace.minGapMs, pace.gapMs * 0.8); pace.okStreak = 0; }
        return resp;
      }
      last = resp;
      if (resp.status === 429) {
        pace.gapMs = Math.min(pace.maxGapMs, pace.gapMs * 2);
        pace.okStreak = 0;
        pace.nextAt = Date.now() + Math.min(60_000, 4000 * 2 ** attempt);   // everyone backs off
      } else if (resp.status < 500) {
        return resp;   // other 4xx: no point retrying
      }
    } catch {
      lastStatus.set(sym, 0);
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500);
  }
  return last ?? new Response(null, { status: 599 });
}
globalThis.fetch = pacedFetch as typeof fetch;

async function fetchAll(symbols: string[], concurrency = 4): Promise<Map<string, YahooBar[]>> {
  const out = new Map<string, YahooBar[]>();
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < symbols.length) {
      const sym = symbols[i++];
      const bars = await fetchYahooOHLCV(sym, "2y", "1d").catch(() => [] as YahooBar[]);   // as the Worker scores a symbol
      if (bars.length) out.set(sym, bars);
      if (++done % 100 === 0) console.log(`  fetched ${done}/${symbols.length} (gap ${Math.round(pace.gapMs)} ms)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ── D1 through Cloudflare's HTTP API ────────────────────────────────────────
// Statements are sent fully written out (no bound parameters: the API takes
// parameters only as strings). Every value comes from this script: tickers
// from the fixed lists, numbers, and labels from the Worker's code.
function lit(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}
/** Fills the `?` placeholders of a Worker statement (none sit inside quotes). */
function bindLiterals(sql: string, params: unknown[]): string {
  let k = 0;
  const out = sql.replace(/\?/g, () => lit(params[k++]));
  if (k !== params.length) throw new Error(`bindLiterals: ${k} placeholders, ${params.length} values`);
  return out;
}

interface D1Result { results: Array<Record<string, unknown>>; success: boolean; meta?: { rows_read?: number; rows_written?: number } }
const d1Stats = { requests: 0, rowsRead: 0, rowsWritten: 0 };

async function d1(statements: string[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  const url = process.env.D1_QUERY_URL ||   // a local stand-in, for tests
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${databaseId()}/query`;
  for (let attempt = 0; ; attempt++) {
    const resp = await realFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ batch: statements.map((sql) => ({ sql })) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await resp.json().catch(() => null) as { success?: boolean; result?: D1Result[]; errors?: unknown } | null;
    if (resp.ok && data?.success && Array.isArray(data.result)) {
      d1Stats.requests++;
      for (const r of data.result) { d1Stats.rowsRead += r.meta?.rows_read ?? 0; d1Stats.rowsWritten += r.meta?.rows_written ?? 0; }
      return data.result;
    }
    const why = `D1 API HTTP ${resp.status}: ${JSON.stringify(data?.errors ?? null).slice(0, 400)}`;
    if (attempt >= 2 || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) throw new Error(why);
    console.warn(`${why}; retrying`);
    await sleep(3000 * (attempt + 1));
  }
}

// ── The scan ─────────────────────────────────────────────────────────────────
function addDays(date: string, k: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + k * 864e5).toISOString().slice(0, 10);
}

/** The session whose close the scan expects: today after 16:15 New York, else the weekday before. */
function expectedSession(now: Date): string {
  const ny = nyClock(now);
  let d = ny.date;
  const weekday = (x: string) => { const g = new Date(x + "T12:00:00Z").getUTCDay(); return g >= 1 && g <= 5; };
  if (weekday(d) && ny.minutes >= 16 * 60 + 15) return d;
  do { d = addDays(d, -1); } while (!weekday(d));
  return d;
}

/** Most common last-bar date: the session the data reaches. */
function sessionOf(bars: Map<string, YahooBar[]>): string | null {
  const count = new Map<string, number>();
  for (const b of bars.values()) { const d = b[b.length - 1].date; count.set(d, (count.get(d) ?? 0) + 1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null;
}

function fmt(v: number | null | undefined, d = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const now = new Date();
  const useD1 = !DRY_RUN;
  if (useD1 && (!ACCOUNT || !TOKEN)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_TOKEN must be set (repository secrets); use --dry-run to scan without D1");
  }

  // 1) What the Worker's scoring reads (as loadWatchContext in index.ts),
  //    the shared watchlist, the open signals and the last scan.
  let stress: number | null = STRESS_ARG != null ? Number(STRESS_ARG) : null;
  let spy6m: number | null = null;
  let watchlist = new Set<string>();
  let active: SignalRow[] = [];
  let previous: ScanStatus | null = null;
  if (useD1) {
    const [regime, spx, wl, act, last] = await d1([
      "SELECT value FROM kv_store WHERE key = 'regime:current'",
      "SELECT meta_json FROM observations WHERE indicator_id = 'sp500_off_high' ORDER BY as_of DESC LIMIT 1",
      "SELECT symbol FROM watchlist",
      "SELECT * FROM signal_log WHERE status IN ('pending','open')",
      `SELECT value FROM kv_store WHERE key = ${lit(SCAN_STATUS_KEY)}`,
    ]);
    try {
      const r = JSON.parse(String(regime.results[0]?.value ?? "null")) as { version?: number; stress_count?: number } | null;
      if (STRESS_ARG == null && r?.version === 2 && typeof r.stress_count === "number") stress = r.stress_count;
    } catch { /* keep null */ }
    try {
      const meta = JSON.parse(String(spx.results[0]?.meta_json ?? "null")) as { chg_6m_pct?: number } | null;
      if (typeof meta?.chg_6m_pct === "number") spy6m = meta.chg_6m_pct;
    } catch { /* keep null */ }
    watchlist = new Set(wl.results.map((r) => String(r.symbol)));
    active = act.results as unknown as SignalRow[];
    try { previous = JSON.parse(String(last.results[0]?.value ?? "null")) as ScanStatus | null; } catch { previous = null; }
  }

  const expected = expectedSession(now);
  if (!FORCE && !ONLY && previous?.scan_date === expected) {
    console.log(`Scan for ${expected} already stored at ${previous.finished_at}; nothing to do (use --force to rerun).`);
    return;
  }

  // 2) Bars: the universe, plus symbols of open "scan" signals that left it.
  const scanActive = active.filter((a) => a.source === "scan");
  const universe = ONLY ?? [...SCAN_UNIVERSE];
  const extra = [...new Set(scanActive.map((a) => a.symbol))].filter((s) => !universe.includes(s));
  console.log(`Scanning ${universe.length} symbols (+${extra.length} with open scan signals); stress ${stress ?? "n/a"}, SPY 6m ${spy6m ?? "n/a"}`);
  const bars = await fetchAll([...universe, ...extra]);
  const failed = [...universe, ...extra].filter((s) => !bars.has(s));
  const session = sessionOf(bars);
  if (!session) throw new Error(`No bars at all (${failed.length} failed; last HTTP statuses: ${[...new Set(lastStatus.values())].join(",")})`);

  // 3) Score every stock whose bars reach that session.
  const candidates: ScanCandidate[] = [];
  const scored: Array<{ m: WatchMetrics; b: YahooBar[]; complete: boolean }> = [];
  const errors: string[] = [];
  let behind = 0;
  for (const sym of universe) {
    const b = bars.get(sym);
    if (!b) continue;
    if (b[b.length - 1].date !== session) { behind++; continue; }
    const complete = lastBarComplete(b, now);
    let m: WatchMetrics;
    try {
      m = computeMetrics(sym, b, { stress, spy6m, lastBarComplete: complete });
    } catch (e) {
      // One stock's odd history must not stop the scan (e.g. the pattern
      // code throws on a listing with exactly 100 daily bars).
      errors.push(`${sym} (${b.length} bars): ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    scored.push({ m, b, complete });
    const c = scanCandidate(m);
    if (c) candidates.push(c);
  }
  const coverage = scored.length / universe.length;
  const sorted = sortCandidates(candidates);
  // The scan's date is the finished bar its setups read: today's session
  // after the close, the one before while a session is still trading.
  const scanDate = scored.length && !scored[0].complete ? scored[0].b[scored[0].b.length - 2].date : session;

  // 4) Grade the open scan signals, then log new Special Focus names.
  const changed: SignalRow[] = [];
  for (const sig of scanActive) {
    const b = bars.get(sig.symbol);
    if (!b) continue;
    const next = gradeSignal(sig, b, lastBarComplete(b, now));
    if (signalChanged(sig, next)) changed.push(next);
  }
  const stillActive = new Set(active.filter((a) => {
    const c = changed.find((x) => x.id === a.id);
    return !c || c.status === "pending" || c.status === "open";
  }).map((a) => a.symbol));
  const fresh: SignalRow[] = [];
  for (const { m, b, complete } of scored) {
    if (m.focus_score < FOCUS_MIN || watchlist.has(m.symbol) || stillActive.has(m.symbol)) continue;
    for (const sig of signalsFromMetrics(m, b, complete, "scan").slice(0, 1)) fresh.push(gradeSignal(sig, b, complete));
  }

  // 5) Statements. A scan with poor coverage stores only the grades.
  const stamp = new Date().toISOString();
  const store = coverage >= MIN_COVERAGE;
  const sql: string[] = [];
  if (store) {
    sql.push(`DELETE FROM market_scan WHERE scan_date = ${lit(scanDate)} OR scan_date < ${lit(addDays(scanDate, -SCAN_KEEP_DAYS))}`);
    for (let i = 0; i < sorted.length; i += 25) {
      const values = sorted.slice(i, i + 25).map((c) =>
        `(${[scanDate, c.symbol, c.score, JSON.stringify(c), stamp].map(lit).join(", ")})`);
      sql.push(`INSERT INTO market_scan (scan_date, symbol, focus_score, payload_json, created_at) VALUES\n${values.join(",\n")}`);
    }
  }
  for (const r of changed) sql.push(bindLiterals(UPDATE_SIGNAL_SQL, [...GRADE_COLS.map((k) => r[k]), stamp, r.id ?? -1]));
  if (store) {
    for (const r of fresh) sql.push(bindLiterals(INSERT_SIGNAL_SQL, [...SIGNAL_COLS.map((k) => r[k] ?? null), stamp, stamp]));
  }
  const status: ScanStatus = {
    scan_date: scanDate, finished_at: stamp, universe: universe.length, scanned: scored.length,
    failed: failed.filter((s) => universe.includes(s)).length, candidates: sorted.length,
    logged: store ? fresh.length : 0, graded: changed.length, stress,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  if (store && !ONLY) {
    sql.push(`INSERT INTO kv_store (key, value, updated_at) VALUES (${lit(SCAN_STATUS_KEY)}, ${lit(JSON.stringify(status))}, datetime('now')) ` +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  }
  if (SQL_OUT) writeFileSync(SQL_OUT, sql.map((s) => s + ";").join("\n") + "\n");
  if (useD1 && !ONLY) await d1(sql);

  // 6) Report.
  const lines = [
    `Session ${session}, scan date ${scanDate}: ${scored.length}/${universe.length} scored (${failed.length} failed, ${behind} behind), ` +
      `${sorted.length} candidates, ${fresh.length} new scan signals, ${changed.length} graded, ${status.seconds}s` +
      (useD1 ? `; D1 ${d1Stats.requests} requests, ${d1Stats.rowsRead} rows read, ${d1Stats.rowsWritten} written` : "; dry run"),
  ];
  if (failed.length) lines.push(`Failed: ${failed.slice(0, 30).join(" ")}${failed.length > 30 ? " …" : ""}`);
  if (errors.length) lines.push(`Scoring errors: ${errors.join("; ")}`);
  console.log(lines.join("\n"));
  const table = ["| Symbol | Setup | Buy | Stop | Risk | Score | Tags |", "|---|---|---|---|---|---|---|",
    ...sorted.map((c) => `| ${c.symbol} | ${c.label}${c.stress ? " (stress)" : ""} | ${c.entry_type === "close" ? "close " : "> "}${fmt(c.buy)} | ${fmt(c.stop)} | ${fmt(c.risk_pct, 1)}% | ${c.score} | ${c.tags.join(" ")} |`)];
  console.log(table.join("\n"));
  for (const r of fresh) console.log(`logged ${r.symbol} ${r.setup} ${r.signal_date} ${r.entry_type} ${r.trigger} stop ${r.stop} → ${r.status}`);
  for (const r of changed) console.log(`graded ${r.symbol} ${r.setup} ${r.signal_date} → ${r.status} plan ${fmt(r.r_plan)} trend ${fmt(r.r_trend)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Market scan ${scanDate}\n\n${lines.join("\n\n")}\n\n${table.join("\n")}\n`);
  }
  if (!store) {
    throw new Error(`Only ${(coverage * 100).toFixed(0)}% of the universe had bars for ${session}; the scan was not stored (Yahoo throttling?)`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
