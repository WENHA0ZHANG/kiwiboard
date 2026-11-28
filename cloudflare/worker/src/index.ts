import type { Env, Observation } from "./lib/types";
import { ALL_INDICATOR_IDS } from "./lib/types";
import {
  getLatestObservations,
  getRecentObservations,
  upsertObservations,
  getLastUpdateTime,
  setLastCronRun,
  getMarketOverviewRows,
  upsertMarketOverviewRows,
  getNewsCacheEntry,
  upsertNewsCache,
  getWatchlist,
  addWatchlistSymbol,
  removeWatchlistSymbol,
  reorderWatchlist,
  getWatchlistMetricsFor,
  getWatchlistMetricAges,
  upsertWatchlistMetrics,
} from "./lib/db";
import type { WatchlistRow } from "./lib/db";
import { getSupabaseUser, isAdmin } from "./lib/auth";
import { checkRegimeAlert, currentRegime, deliver, pushConfigured, regimeMessage } from "./lib/alerts";
import type { AlertTarget } from "./lib/alerts";
import { sbDeleteUser, sbSelect, supabaseAdminConfigured } from "./lib/supabase";
import { computeSignals } from "./lib/signals";
import { getRegime, readRegimeSnapshot, refreshRegimeSnapshot } from "./lib/regime-store";
import { fetchYahooChart, fetchYahooOHLCV, fetchYahooNews, fetchYahooSpark } from "./lib/yahoo";
import type { YahooBar, YahooChartPoint } from "./lib/yahoo";
import { ASSET_RE, assetLabel, resolveSymbol, searchSymbols, verifySymbol } from "./lib/symbols";
import type { SymbolKind, SymbolMatch } from "./lib/symbols";
import { computeMetrics, ema } from "./lib/analysis";
import type { WatchMetrics } from "./lib/analysis";
import {
  getActiveSignals, gradeSignal, insertSignals, recentSignals, signalChanged, signalsFromMetrics, updateSignals,
} from "./lib/signal-log";
import type { SignalRow } from "./lib/signal-log";
import { fetchStooqDailyCloses, fetchStooqQuote } from "./lib/stooq";
import { fetchCompanyNews, fetchGeneralNews, newsTickerForYahooSymbol } from "./lib/finnhub";
import { DAILY_SOURCES, fetchAllProviders } from "./lib/fetchers";
import { countSubrequests } from "./lib/subrequests";
import { fetchNdxBreadth, fetchSp500Breadth } from "./lib/breadth";
import { WORLD_INDICES, getIndexMeta } from "./lib/world";

// ── CORS helpers ─────────────────────────────────────────────────────────────
// The SPA is served from Pages while the API lives on workers.dev, so every
// non-simple request is preflighted. DELETE must be advertised here or the
// browser blocks the watchlist remove button before it ever reaches us.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  // Authorization carries the Supabase access token for admin-only writes.
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // All API responses are dynamic — never let Cloudflare's edge or the
      // browser cache them, otherwise the dashboard can show a stale
      // "Last Updated" timestamp depending on which edge / cache hop is hit.
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      ...CORS,
    },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

// ── Indicator metadata ────────────────────────────────────────────────────────
const INDICATOR_NAMES: Record<string, string> = {
  us_high_yield_spread:    "US High Yield Option-Adjusted Spread",
  cnn_fear_greed_index:    "Fear & Greed Index",
  cnn_put_call_options:    "Put/Call Ratio (5-Day Average)",
  sp500_pe_ratio:          "S&P 500 Price-to-Earnings Ratio",
  nasdaq100_pe_ratio:      "Nasdaq 100 Price-to-Earnings Ratio",
  sp500_rsi:               "S&P 500 Relative Strength Index",
  nasdaq100_above_20d_ma:  "Nasdaq 100 Above 20-Day Moving Average (%)",
  vix:                     "S&P 500 Volatility Index",
  cboe_skew:               "CBOE SKEW (Tail-Risk Hedging)",
  yc_10y_2y:               "10Y-2Y Treasury Yield Curve",
};

const INDICATOR_SOURCE_URLS: Record<string, string> = {
  us_high_yield_spread:   "https://fred.stlouisfed.org/series/BAMLH0A0HYM2",
  cnn_fear_greed_index:   "https://edition.cnn.com/markets/fear-and-greed",
  cnn_put_call_options:   "https://edition.cnn.com/markets/fear-and-greed",
  sp500_pe_ratio:         "https://www.multpl.com/s-p-500-pe-ratio/table/by-month",
  nasdaq100_pe_ratio:     "https://worldperatio.com/index/nasdaq-100/",
  sp500_rsi:              "https://www.investing.com/indices/us-spx-500-technical",
  nasdaq100_above_20d_ma: "https://finance.yahoo.com/quote/%5ENDX/components/",
  vix:                    "https://edition.cnn.com/markets/fear-and-greed",
  cboe_skew:              "https://finance.yahoo.com/quote/%5ESKEW",
  yc_10y_2y:              "https://fred.stlouisfed.org/series/T10Y2Y",
};

const INDICATOR_THRESHOLDS: Record<string, { top?: number; bottom?: number; top_zone?: number[] }> = {
  cnn_fear_greed_index:   { top: 75.0, bottom: 25.0 },
  cnn_put_call_options:   { top: 0.55, bottom: 0.95 },
  vix:                    { top: 14.0, bottom: 25.0 },
  sp500_rsi:              { top: 70.0, bottom: 30.0 },
  sp500_pe_ratio:         { top: 31.0, bottom: 25.0 },
  nasdaq100_pe_ratio:     { top: 30.0, bottom: 26.0 },
  nasdaq100_above_20d_ma: { top: 80.0, bottom: 20.0 },
  us_high_yield_spread:   { top: 2.7, bottom: 4.0 },
  cboe_skew:              { top: 155.0, bottom: 135.0 },
  yc_10y_2y:              { top_zone: [-0.05, 0.6] },
};

// ── Default market symbols ────────────────────────────────────────────────────
const DEFAULT_MARKET_SYMBOLS = [
  "^spx", "^dji", "^ndq",
  "btc.v", "xauusd", "xagusd",
  "nvo.us", "aapl.us", "goog.us", "nvda.us", "tsla.us",
  "meta.us", "msft.us", "hood.us", "mu.us",
  "brk-b.us", "rklb.us", "amzn.us", "ko.us", "zeta.us", "q.us", "sols.us",
];

// `name` is the display label the SPA uses in the market tables — keep it
// stable even when Yahoo's own ticker looks different (e.g. ^GSPC vs
// S&P 500, GC=F vs XAU, BTC-USD vs BTC). Previously we wrote `name: yahooSym`
// into D1 which caused the Reload button to "rename" rows to their Yahoo
// slugs. Index labels carry no "^": people read names, not tickers.
const DEFAULT_ITEMS: Array<{ symbol: string; yahoo: string; name: string }> = [
  { symbol: "^spx",     yahoo: "^GSPC",   name: "S&P 500"   },
  { symbol: "^dji",     yahoo: "^DJI",    name: "Dow Jones" },
  { symbol: "^ndq",     yahoo: "^IXIC",   name: "Nasdaq"    },
  { symbol: "btc.v",    yahoo: "BTC-USD", name: "BTC"   },
  { symbol: "xauusd",   yahoo: "GC=F",    name: "XAU"   },
  { symbol: "xagusd",   yahoo: "SI=F",    name: "XAG"   },
  { symbol: "nvo.us",   yahoo: "NVO",     name: "NVO"   },
  { symbol: "aapl.us",  yahoo: "AAPL",    name: "AAPL"  },
  { symbol: "goog.us",  yahoo: "GOOG",    name: "GOOG"  },
  { symbol: "nvda.us",  yahoo: "NVDA",    name: "NVDA"  },
  { symbol: "tsla.us",  yahoo: "TSLA",    name: "TSLA"  },
  { symbol: "meta.us",  yahoo: "META",    name: "META"  },
  { symbol: "msft.us",  yahoo: "MSFT",    name: "MSFT"  },
  { symbol: "hood.us",  yahoo: "HOOD",    name: "HOOD"  },
  { symbol: "mu.us",    yahoo: "MU",      name: "MU"    },
  { symbol: "brk-b.us", yahoo: "BRK-B",   name: "BRK-B" },
  { symbol: "rklb.us",  yahoo: "RKLB",    name: "RKLB"  },
  { symbol: "amzn.us",  yahoo: "AMZN",    name: "AMZN"  },
  { symbol: "ko.us",    yahoo: "KO",      name: "KO"    },
  { symbol: "zeta.us",  yahoo: "ZETA",    name: "ZETA"  },
  { symbol: "q.us",     yahoo: "Q",       name: "Q"     },
  { symbol: "sols.us",  yahoo: "SOLS",    name: "SOLS"  },
];

function friendlyNameForSymbol(symbol: string): string {
  const s = (symbol || "").trim();
  for (const item of DEFAULT_ITEMS) {
    if (item.symbol.toLowerCase() === s.toLowerCase()) return item.name;
  }
  if (s.toLowerCase().endsWith(".us")) return s.slice(0, -3).toUpperCase();
  return s.toUpperCase();
}

function toYahooSymbol(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  for (const item of DEFAULT_ITEMS) {
    if (item.symbol.toLowerCase() === s.toLowerCase()) return item.yahoo;
  }
  if (s.toLowerCase().endsWith(".us")) return s.slice(0, -3).toUpperCase();
  return s.toUpperCase();
}

function normalizeStockSymbol(raw: string): string | null {
  let s = (raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (s.endsWith(".US")) s = s.slice(0, -3);
  s = s.replace(/\./g, "-");
  if (!/^[A-Z0-9-]+$/.test(s)) return null;
  return `${s}.US`;
}

// ── Market overview: fetch from Yahoo ────────────────────────────────────────
type MarketItem = { symbol: string; yahoo: string; name: string };
const MARKET_ROW_FALLBACKS = 3;  // per-symbol chart calls allowed when spark skips a symbol

/**
 * Rows for many symbols with one spark request per 20 symbols (the 22
 * defaults used to cost 22 requests). A symbol spark leaves out is retried
 * with its own chart request, up to MARKET_ROW_FALLBACKS of them.
 */
async function buildMarketRows(items: MarketItem[]): Promise<Record<string, unknown>[]> {
  let series = new Map<string, YahooChartPoint[]>();
  try {
    series = await fetchYahooSpark(items.map((i) => i.yahoo), "1y", "1d");
  } catch (e) {
    console.error("buildMarketRows: spark failed", e);
  }
  const rows: Record<string, unknown>[] = [];
  const missing: MarketItem[] = [];
  for (const item of items) {
    const points = series.get(item.yahoo);
    const row = points ? marketRowFromPoints(item, points) : null;
    if (row) rows.push(row); else missing.push(item);
  }
  const retried = await Promise.allSettled(
    missing.slice(0, MARKET_ROW_FALLBACKS).map((i) => buildMarketRow(i.symbol, i.yahoo, i.name)),
  );
  for (const r of retried) if (r.status === "fulfilled" && r.value) rows.push(r.value);
  return rows;
}

async function buildMarketRow(
  symbol: string,
  yahooSym: string,
  displayName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const points = await fetchYahooChart(yahooSym, "1y", "1d");
    return marketRowFromPoints({ symbol, yahoo: yahooSym, name: displayName }, points);
  } catch {
    return null;
  }
}

function marketRowFromPoints(item: MarketItem, points: YahooChartPoint[]): Record<string, unknown> | null {
  if (!points.length) return null;
  const latest = points[points.length - 1];
  const close = latest.close;

  const w = points.length > 5  ? points[points.length - 6].close  : null;
  const m = points.length > 21 ? points[points.length - 22].close : null;
  const q = points.length > 63 ? points[points.length - 64].close : null;
  // 1Y % vs oldest bar in Yahoo's `range=1y` window (≈ 252 trading days).
  // Yahoo often returns 251 daily bars for US equities (^GSPC etc.), so a
  // threshold of 252 would permanently blank the 1Y column — `points[0]` is
  // always the window anchor for this fetch.
  const y = points.length >= 2 ? points[0].close : null;

  const pct = (prev: number | null) => prev ? Math.round((close / prev - 1) * 10000) / 100 : null;
  return {
    symbol: item.symbol, name: item.name, as_of: latest.date, close,
    chg_1w_pct: pct(w), chg_1m_pct: pct(m),
    chg_3m_pct: pct(q), chg_1y_pct: pct(y),
    source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(item.yahoo)}`,
  };
}

// ── Watchlist defaults (page 05) ─────────────────────────────────────────────
// Seeded once into D1 the first time the watchlist is read while empty.
const WATCHLIST_DEFAULTS = [
  "NVO", "AAPL", "GOOG", "NVDA", "TSLA", "META", "MSFT",
  "HOOD", "MU", "BRK-B", "RKLB", "AMZN", "KO",
];

async function seedDefaultWatchlistIfEmpty(env: Env): Promise<boolean> {
  // A kv flag means we only ever auto-seed once — so deliberately clearing
  // the whole list later won't keep re-filling it.
  const flag = await env.DB.prepare(
    "SELECT value FROM kv_store WHERE key = 'watchlist_seeded'",
  ).first<{ value: string }>();
  if (flag) return false;

  const now = new Date().toISOString();
  const stmts = WATCHLIST_DEFAULTS.map((s) =>
    env.DB.prepare(
      `INSERT INTO watchlist (symbol, name, note, added_at)
       VALUES (?, ?, NULL, ?) ON CONFLICT(symbol) DO NOTHING`,
    ).bind(s, s, now),
  );
  stmts.push(
    env.DB.prepare(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ('watchlist_seeded', '1', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
  );
  await env.DB.batch(stmts);
  return true;
}

// ── Market-timing tiles (page 05) ────────────────────────────────────────────
// Generic trend read on SPY & QQQ (price vs 21 EMA, 8/21/50 EMA stack) — the
// "is this a friendly environment?" gauge at the top of the page. No
// proprietary methodology text is reproduced.
async function buildMarketTiming(yahooSym: string, name: string) {
  const bars = await fetchYahooOHLCV(yahooSym, "1y", "1d");
  if (bars.length < 60) return { symbol: yahooSym, name, ok: false } as Record<string, unknown>;
  const closes = bars.map((b) => b.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const n = bars.length;
  const price = closes[n - 1];
  const prev = closes[n - 2];
  const ema8v = e8[n - 1], ema21v = e21[n - 1], ema50v = e50[n - 1];

  const above21 = price > ema21v;
  const stacked = ema8v > ema21v && ema21v > ema50v;
  const rising21 = ema21v > e21[n - 6];

  let status: string;
  let tier: string;
  if (above21 && stacked && rising21) { status = "Risk-On"; tier = "on"; }
  else if (above21 && ema8v > ema21v) { status = "Constructive"; tier = "mild"; }
  else if (above21) { status = "Mixed"; tier = "neutral"; }
  else { status = "Risk-Off"; tier = "off"; }

  return {
    symbol: yahooSym, name, ok: true,
    price: Math.round(price * 100) / 100,
    chg_1d_pct: prev ? Math.round((price / prev - 1) * 10000) / 100 : null,
    ema8: Math.round(ema8v * 100) / 100,
    ema21: Math.round(ema21v * 100) / 100,
    ema50: Math.round(ema50v * 100) / 100,
    above_21ema: above21,
    stacked,
    status, tier,
  } as Record<string, unknown>;
}

// ── Watchlist metric builder (page 05) ───────────────────────────────────────
// Pull ~2y of daily OHLCV from Yahoo for a single symbol and run the analysis
// library over it. Returns null on a hard fetch failure.
async function scoreSymbol(symbol: string, name: string | null, wctx: WatchContext) {
  const yahooSym = symbol; // watchlist symbols are stored as plain Yahoo tickers
  const bars = await fetchYahooOHLCV(yahooSym, "2y", "1d");
  if (!bars.length) return null;
  const complete = lastBarComplete(bars);
  const m = computeMetrics(symbol, bars, { ...wctx, lastBarComplete: complete });
  return { metrics: { ...m, name: name ?? symbol }, bars, complete };
}

async function buildWatchMetrics(symbol: string, name: string | null, wctx: WatchContext) {
  return (await scoreSymbol(symbol, name, wctx))?.metrics ?? null;
}

// What the watchlist scoring needs besides the stock's own bars: the regime
// stress count (pullback setups don't score at 2 or more) and SPY's
// 6-month change for the relative-strength tag. Two one-row reads.
type WatchContext = { stress: number | null; spy6m: number | null };

async function loadWatchContext(env: Env): Promise<WatchContext> {
  const [v2, spx] = await Promise.all([
    readRegimeSnapshot(env).catch(() => null),
    env.DB.prepare("SELECT meta_json FROM observations WHERE indicator_id = 'sp500_off_high' ORDER BY as_of DESC LIMIT 1")
      .first<{ meta_json: string | null }>().catch(() => null),
  ]);
  let spy6m: number | null = null;
  try {
    const meta = spx?.meta_json ? JSON.parse(spx.meta_json) as { chg_6m_pct?: number } : null;
    if (typeof meta?.chg_6m_pct === "number") spy6m = meta.chg_6m_pct;
  } catch { /* keep null */ }
  return { stress: v2?.stress_count ?? null, spy6m };
}

/** New York date, weekday and minutes since midnight. */
function nyClock(now = new Date()): { date: string; weekday: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * False while the newest daily bar is today's New York session and may still
 * change: until 16:15, so the 16:00 run doesn't log a setup from a close the
 * auction hasn't settled yet.
 */
function lastBarComplete(bars: YahooBar[], now = new Date()): boolean {
  const last = bars[bars.length - 1];
  if (!last) return true;
  const ny = nyClock(now);
  return last.date !== ny.date || ny.minutes >= 16 * 60 + 15;
}

// ── Watchlist access control ────────────────────────────────────────────────
// The shared watchlist is what every visitor sees, so writing to it requires
// a signed-in Supabase user whose email is in the ADMIN_EMAILS secret.
// (Previously POST/DELETE/reorder were open to anyone on the internet.)
async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const user = await getSupabaseUser(request, env);
  if (!user) return err("Sign in required", 401);
  if (!isAdmin(user, env)) return err("Only the site admin can edit the shared watchlist", 403);
  return null;
}

// Simple D1-backed limiter: true at most once per `seconds` for a given key.
async function allowOncePer(env: Env, key: string, seconds: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const prev = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?")
    .bind(key).first<{ value: string }>();
  if (prev && now - (parseInt(prev.value, 10) || 0) < seconds) return false;
  await env.DB.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, String(now)).run();
  return true;
}

// `?refresh=1` re-scores every requested symbol (one Yahoo fetch each), so an
// anonymous caller gets at most one forced refresh per IP every 2 minutes;
// otherwise the request is served from cache instead of failing.
function allowWatchlistRefresh(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return allowOncePer(env, `ratelimit:wlrefresh:${ip}`, 120);
}

const WATCH_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

// Light per-isolate throttle for the ticker type-ahead: one request per
// pause in typing, so 60 a minute per IP is plenty for a person.
const symbolSearchHits = new Map<string, { at: number; n: number }>();
function allowSymbolSearch(request: Request): boolean {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const now = Date.now();
  const e = symbolSearchHits.get(ip);
  if (!e || now - e.at > 60_000) {
    if (symbolSearchHits.size > 5000) symbolSearchHits.clear();
    symbolSearchHits.set(ip, { at: now, n: 1 });
    return true;
  }
  e.n += 1;
  return e.n <= 60;
}
const MAX_PERSONAL_SYMBOLS = 100;   // matches the per-list cap in Supabase
const MAX_SCORED_PER_REQUEST = 12;  // keeps one request inside the CPU budget
const PERSONAL_STALE_SECONDS = 30 * 60;

// Score a list of symbols from the shared metrics cache, computing what's
// missing. Personal lists (`personal = true`) are arbitrary and possibly long,
// so only a few symbols are (re)scored per request; anything still waiting is
// returned in `pending` and the page asks again. Personal symbols also aren't
// refreshed by the cron, so cached numbers older than 30 min are re-scored
// (while still being shown in the meantime).
async function scoreWatchlist(
  env: Env,
  ctx: ExecutionContext,
  entries: WatchlistRow[],
  force: boolean,
  personal: boolean,
) {
  const symbols = entries.map((e) => e.symbol);
  const { map, ageSec, freshest: cachedFreshest } = await getWatchlistMetricsFor(
    env.DB, symbols, !personal && force ? 0 : 24 * 3600,
  );
  let freshest = cachedFreshest;
  const needs = entries.filter((e) =>
    !map[e.symbol] || (personal && (force || ageSec[e.symbol] > PERSONAL_STALE_SECONDS)),
  );
  const targets = personal ? needs.slice(0, MAX_SCORED_PER_REQUEST) : needs;
  if (targets.length) {
    const wctx = await loadWatchContext(env);
    const settled = await Promise.allSettled(targets.map((w) => buildWatchMetrics(w.symbol, w.name, wctx)));
    const writes: Array<{ symbol: string; focus_score: number; payload: unknown }> = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "fulfilled" && r.value) {
        map[targets[i].symbol] = r.value;
        writes.push({ symbol: targets[i].symbol, focus_score: r.value.focus_score ?? 0, payload: r.value });
      }
    }
    if (writes.length) {
      ctx.waitUntil(upsertWatchlistMetrics(env.DB, writes));
      freshest = Date.now();
    }
  }
  const scored = new Set(targets.map((t) => t.symbol));
  const pending = needs.filter((e) => !scored.has(e.symbol)).map((e) => e.symbol);

  const rows = entries.map((w) => {
    const m = (map[w.symbol] as Record<string, unknown>) || null;
    return {
      symbol: w.symbol,
      name: w.name || (m?.name as string) || w.symbol,
      note: w.note,
      added_at: w.added_at,
      metrics: m,
    };
  });

  // Special focus: anything with focus_score >= 4, sorted by score desc.
  const score = (r: { metrics: unknown }) => (r.metrics as { focus_score?: number } | null)?.focus_score ?? 0;
  const focus = rows.filter((r) => score(r) >= 4).sort((a, b) => score(b) - score(a));

  return {
    rows, focus, pending,
    computed_at: freshest ? new Date(freshest).toISOString() : null,
  };
}

// Shared-watchlist pacing for the */30 cron. Each symbol costs one Yahoo
// chart request (OHLCV has no batch endpoint), so a run refreshes at most
// WATCHLIST_REFRESH_MAX symbols, stalest first, and a longer list simply
// takes more than one run. Daily bars only move while the US market is open;
// outside that window each symbol is refreshed every 6 hours, which keeps the
// cached rows well under the 24 hours /api/watchlist accepts.
const WATCHLIST_REFRESH_MAX = 20;
const WATCHLIST_MIN_AGE_OPEN_SEC = 25 * 60;
const WATCHLIST_MIN_AGE_CLOSED_SEC = 6 * 3600;

/** Mon–Fri 09:00–17:00 New York time: the session plus the first run after the close. */
function usMarketWindowOpen(now = new Date()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 && minutes < 17 * 60;
}

async function refreshWatchlistMetrics(
  env: Env,
  pace?: { max: number; minAgeSec: number },
): Promise<{ wrote: number; due: number; total: number; added: number; graded: number }> {
  const wl = await getWatchlist(env.DB);
  if (!wl.length) return { wrote: 0, due: 0, total: 0, added: 0, graded: 0 };
  let targets = wl;
  if (pace) {
    const ages = await getWatchlistMetricAges(env.DB, wl.map((w) => w.symbol));
    const age = (symbol: string) => ages[symbol] ?? Infinity;
    targets = wl
      .filter((w) => age(w.symbol) >= pace.minAgeSec)
      .sort((a, b) => age(b.symbol) - age(a.symbol))
      .slice(0, pace.max);
  }
  const wctx = await loadWatchContext(env);
  const settled = await Promise.allSettled(
    targets.map((w) => scoreSymbol(w.symbol, w.name, wctx)),
  );
  const out: Array<{ symbol: string; focus_score: number; payload: unknown }> = [];
  const scored: Array<{ metrics: WatchMetrics; bars: YahooBar[]; complete: boolean }> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value) {
      out.push({ symbol: targets[i].symbol, focus_score: r.value.metrics.focus_score ?? 0, payload: r.value.metrics });
      scored.push(r.value);
    }
  }
  if (out.length) await upsertWatchlistMetrics(env.DB, out);
  let logged = { added: 0, graded: 0 };
  if (pace && scored.length) {
    try { logged = await logAndGradeSignals(env, scored, new Set(wl.map((w) => w.symbol))); } catch (e) { console.error("signal log failed", e); }
  }
  return { wrote: out.length, due: targets.length, total: wl.length, ...logged };
}

// ── Signal log (Phase 3) ─────────────────────────────────────────────────────
const ORPHAN_GRADES_PER_RUN = 3;
// The cron's shared-watchlist refresh already has each symbol's daily bars,
// so it logs new setups and re-grades the open ones from the same data: no
// extra outbound requests. A symbol with a pending or open signal logs
// nothing new until that one is done (one trade at a time, as tested).
async function logAndGradeSignals(
  env: Env,
  scored: Array<{ metrics: WatchMetrics; bars: YahooBar[]; complete: boolean }>,
  watchlist: Set<string>,
): Promise<{ added: number; graded: number }> {
  const bySymbol = new Map(scored.map((x) => [x.metrics.symbol, { bars: x.bars, complete: x.complete }]));
  const active = await getActiveSignals(env.DB);
  // Signals of symbols since removed from the watchlist: fetch their bars
  // here, a few per run, so they still reach a result.
  const orphans = [...new Set(active.map((a) => a.symbol))]
    .filter((sym) => !watchlist.has(sym) && !bySymbol.has(sym)).slice(0, ORPHAN_GRADES_PER_RUN);
  await Promise.all(orphans.map(async (sym) => {
    const bars = await fetchYahooOHLCV(sym, "2y", "1d").catch(() => [] as YahooBar[]);
    if (bars.length) bySymbol.set(sym, { bars, complete: lastBarComplete(bars) });
  }));
  const changed: SignalRow[] = [];
  for (const sig of active) {
    const x = bySymbol.get(sig.symbol);
    if (!x) continue;
    const next = gradeSignal(sig, x.bars, x.complete);
    if (signalChanged(sig, next)) changed.push(next);
  }
  await updateSignals(env.DB, changed);
  const stillActive = new Set(active.filter((a) => {
    const c = changed.find((x) => x.id === a.id);
    return !c || c.status === "pending" || c.status === "open";
  }).map((a) => a.symbol));
  const fresh: SignalRow[] = [];
  for (const x of scored) {
    if (stillActive.has(x.metrics.symbol)) continue;
    for (const sig of signalsFromMetrics(x.metrics, x.bars, x.complete).slice(0, 1)) {
      fresh.push(gradeSignal(sig, x.bars, x.complete));
    }
  }
  await insertSignals(env.DB, fresh);
  return { added: fresh.length, graded: changed.length };
}

// Daily sources (FRED, the two PE pages) are fetched by the */30 cron at most
// this often; the time of each one's last successful fetch lives in kv_store.
const DAILY_SOURCE_HOURS = 6;
const DAILY_SOURCE_KEY = "providers:last_ok";

async function readJsonKv(env: Env, key: string): Promise<Record<string, number>> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).first<{ value: string }>();
  try { return row ? JSON.parse(row.value) as Record<string, number> : {}; } catch { return {}; }
}

async function writeJsonKv(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(key, JSON.stringify(value)).run();
}

// ── After-close jobs (second cron trigger) ───────────────────────────────────
// Must match the second entry of `crons` in wrangler.toml. It fires at 21:10,
// 22:10 and 23:10 UTC on weekdays, after the US close (21:00 UTC in winter,
// 20:00 in summer). The two breadth jobs are the heaviest work in the Worker
// (about 0.5 MB and 1 MB of JSON), so each run does at most one of them, the
// first not yet done today: NDX at 21:10, S&P 500 at 22:10, and the 23:10 run
// retries whichever failed. Every run then refreshes the regime snapshot.
// (The other regime inputs come with the */30 run: MOVE and the S&P 500's
// distance from its high ride on its Yahoo request, the FRED series are
// daily sources.)
const AFTER_CLOSE_CRON = "10 21,22,23 * * 1-5";
const AFTER_CLOSE_KEY = "afterclose:last_ok";

/** Today's date in New York (YYYY-MM-DD). */
function nyDate(now = new Date()): string {
  return nyClock(now).date;
}

async function runAfterCloseJobs(env: Env): Promise<void> {
  const t0 = Date.now();
  const today = nyDate();
  const lastOk = await readJsonKv(env, AFTER_CLOSE_KEY).catch(() => ({} as Record<string, number>));
  const doneToday = (task: string) => lastOk[task] != null && nyDate(new Date(lastOk[task])) === today;

  const heavy: Array<[string, () => Promise<Observation[]>]> = [
    ["ndx_breadth", fetchNdxBreadth],
    ["spx_breadth", fetchSp500Breadth],
  ];
  const next = heavy.find(([name]) => !doneToday(name));
  if (next) {
    const [name, fn] = next;
    try {
      const obs = await fn();
      await upsertObservations(env.DB, obs);
      const last = obs[obs.length - 1];
      console.log(`after-close: ${name} wrote=${obs.length} last=${last?.as_of}:${last?.value} (+${Date.now() - t0}ms)`);
      if (obs.length) {
        lastOk[name] = Date.now();
        await writeJsonKv(env, AFTER_CLOSE_KEY, lastOk);
      }
    } catch (e) {
      console.error(`after-close: ${name} failed`, e);
    }
  } else {
    console.log("after-close: both breadth jobs already done today");
  }

  try {
    const r = await refreshRegimeSnapshot(env);
    console.log(`after-close: regime ${r.score} ${r.label} stress=${r.stress_points} count=${r.stress_count} (+${Date.now() - t0}ms)`);
  } catch (e) {
    console.error("after-close: regime snapshot failed", e);
  }
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── /api/latest ──────────────────────────────────────────────────────────
    if (pathname === "/api/latest" && request.method === "GET") {
      const [latest, regime] = await Promise.all([getLatestObservations(env.DB), getRegime(env).catch(() => null)]);
      const signals = computeSignals(latest, new Date(), regime);
      const signalMap = Object.fromEntries(signals.map((s) => [s.indicator_id, s]));
      const lastUpdate = await getLastUpdateTime(env.DB);

      const rows = ALL_INDICATOR_IDS.map((id) => {
        const o = latest[id];
        const s = signalMap[id];
        const name = s?.title ?? INDICATOR_NAMES[id] ?? id;

        let valueDisplay: string | null = null;
        if (o) {
          const v = o.value;
          if (id === "us_high_yield_spread") {
            const bp = (o.unit === "bp" || v > 30) ? v : v * 100;
            valueDisplay = (bp / 100).toFixed(2);
          } else if (id === "yc_10y_2y") {
            valueDisplay = (v >= 0 ? "+" : "") + v.toFixed(2);
          } else {
            valueDisplay = v.toFixed(2);
          }
        }

        let unitDisplay = o?.unit ?? null;
        if (id === "us_high_yield_spread" && unitDisplay === "bp") unitDisplay = "%";
        if (unitDisplay === "percent") unitDisplay = "%";

        return {
          id, name,
          as_of: o?.as_of ? o.as_of.slice(5) : null,  // "MM-DD"
          value: valueDisplay,
          unit: unitDisplay,
          source: o?.source ?? null,
          source_url: INDICATOR_SOURCE_URLS[id] ?? null,
          is_top: s?.top ?? false,
          is_bottom: s?.bottom ?? false,
          stale: s?.stale ?? false,
        };
      });

      return json({ rows, last_update: lastUpdate });
    }

    // ── /api/alerts ──────────────────────────────────────────────────────────
    if (pathname === "/api/alerts" && request.method === "GET") {
      const [latest, regime] = await Promise.all([getLatestObservations(env.DB), getRegime(env).catch(() => null)]);
      const signals = computeSignals(latest, new Date(), regime);
      return json(signals);
    }

    // ── /api/signal-log ──────────────────────────────────────────────────────
    // The last 20 setups logged from the shared watchlist and their record.
    if (pathname === "/api/signal-log" && request.method === "GET") {
      const rows = await recentSignals(env.DB, 20).catch(() => [] as SignalRow[]);
      const closed = rows.filter((r) => r.status === "closed");
      const avg = (xs: Array<number | null>) => {
        const v = xs.filter((x): x is number => typeof x === "number");
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
      };
      return json({
        rows,
        record: {
          closed: closed.length,
          open: rows.filter((r) => r.status === "open").length,
          pending: rows.filter((r) => r.status === "pending").length,
          wins_plan: closed.filter((r) => (r.r_plan ?? 0) > 0).length,
          avg_r_plan: avg(closed.map((r) => r.r_plan)),
          avg_r_trend: avg(closed.map((r) => r.r_trend)),
        },
      });
    }

    // ── /api/regime ──────────────────────────────────────────────────────────
    if (pathname === "/api/regime" && request.method === "GET") {
      // Scored by the crons after each data update (lib/regime-store.ts).
      return json(await getRegime(env));
    }

    // ── /api/indicator-history ───────────────────────────────────────────────
    if (pathname === "/api/indicator-history" && request.method === "GET") {
      const indicatorId = url.searchParams.get("indicator_id") ?? "";
      const days = Math.max(1, Math.min(parseInt(url.searchParams.get("days") ?? "3650"), 36500));

      if (!ALL_INDICATOR_IDS.includes(indicatorId as typeof ALL_INDICATOR_IDS[number])) {
        return err("Unknown indicator_id", 404);
      }

      const obs = await getRecentObservations(env.DB, indicatorId, days);
      const series = obs.map((o) => {
        let v = o.value;
        let unit = o.unit;
        if (indicatorId === "us_high_yield_spread" && unit === "bp") {
          v = v / 100;
          unit = "%";
        } else if (unit === "percent") { unit = "%"; }
        else if (["0-100", "index", "ratio"].includes(unit)) { unit = ""; }
        return { date: o.as_of, value: v };
      });

      const th = INDICATOR_THRESHOLDS[indicatorId] ?? {};
      return json({ indicator_id: indicatorId, unit: series[0] ? obs[0]?.unit : null, series, ...th });
    }

    // ── /api/symbol-search ───────────────────────────────────────────────────
    // Type-ahead for the "add a stock" boxes: "google" → GOOG …, "nvda" → NVDA.
    // With resolve=1 (Add / Enter) it also says which single listing the text
    // clearly means, so a company name or a typo never becomes an empty row.
    if (pathname === "/api/symbol-search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!q) return json({ q, results: [] });
      if (!allowSymbolSearch(request)) return err("Too many searches, slow down a little", 429);
      // kind=assets: crypto and futures for the Futures & Crypto table.
      const kind: SymbolKind = url.searchParams.get("kind") === "assets" ? "assets" : "stocks";
      const results = await searchSymbols(q, 8, kind);
      const resolve = url.searchParams.get("resolve") === "1";
      if (results === null && !resolve) return err("Symbol search is unavailable right now", 502);
      const body: { q: string; results: SymbolMatch[]; exact?: SymbolMatch | null; how?: string } = {
        q, results: results ?? [],
      };
      if (resolve) {
        const r = await resolveSymbol(q, results, kind);
        body.exact = r ? r.match : null;
        if (r) body.how = r.how;
      }
      const resp = json(body);
      // Matches barely change; let the browser reuse them for a few minutes.
      if (body.results.length || body.exact) resp.headers.set("Cache-Control", "public, max-age=300");
      return resp;
    }

    // ── /api/market-overview ─────────────────────────────────────────────────
    if (pathname === "/api/market-overview" && request.method === "GET") {
      const rawSymbols = url.searchParams.get("symbols") ?? "";
      const extraSymbols = rawSymbols.split(",").map((s) => s.trim()).filter(Boolean);
      const force = url.searchParams.get("refresh") === "1";

      // Build the list of symbols to fetch. Each entry is
      // [symbolKey, yahooSym, displayName].
      const symbolPlan = new Map<string, { yahoo: string; name: string }>();
      for (const item of DEFAULT_ITEMS) {
        symbolPlan.set(item.symbol, { yahoo: item.yahoo, name: item.name });
      }
      for (const raw of extraSymbols) {
        const norm = normalizeStockSymbol(raw);
        if (norm) {
          const yahoo = norm.slice(0, -3);
          symbolPlan.set(norm.toLowerCase(), { yahoo, name: yahoo });
        }
      }
      // Crypto / futures added in the Futures & Crypto table, as Yahoo
      // symbols (ETH-USD, CL=F). Defaults already cover BTC, gold, silver.
      const defaultYahoo = new Set(DEFAULT_ITEMS.map((i) => i.yahoo));
      const extraAssets = (url.searchParams.get("assets") ?? "").split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => ASSET_RE.test(s) && !defaultYahoo.has(s))
        .slice(0, 30);
      for (const yahoo of extraAssets) {
        symbolPlan.set(yahoo.toLowerCase(), { yahoo, name: assetLabel(yahoo) });
      }

      // Try cache from D1 first (unless force refresh). A failed read (D1
      // down or over its daily quota) falls back to fetching everything.
      let dbRows: Record<string, unknown>[] = [];
      if (!force) {
        const syms = [...symbolPlan.keys()];
        try {
          dbRows = await getMarketOverviewRows(env.DB, syms);
        } catch (e) {
          console.error("market-overview: D1 read failed", e);
        }
      }

      const dbMap = new Map<string, Record<string, unknown>>();
      for (const r of dbRows) dbMap.set(String(r.symbol).toLowerCase(), r);

      // The cron refreshes the default rows; symbols people added are only
      // fetched here, so re-fetch those once they're 30 minutes old (crypto
      // trades all weekend). A failed re-fetch keeps the cached row.
      const defaultKeys = new Set(DEFAULT_ITEMS.map((i) => i.symbol));
      const stale = (sym: string, row: Record<string, unknown>) => {
        if (defaultKeys.has(sym)) return false;
        const t = Date.parse(String(row.updated_at ?? "").replace(" ", "T"));
        return !Number.isFinite(t) || Date.now() - t > 30 * 60 * 1000;
      };

      // Fetch missing (or stale) symbols from Yahoo (async, best-effort)
      const missingSymbols = [...symbolPlan.entries()].filter(([sym]) => {
        const row = dbMap.get(sym);
        return !row || stale(sym, row);
      });
      if (missingSymbols.length > 0) {
        const newRows = await buildMarketRows(
          missingSymbols.map(([sym, plan]) => ({ symbol: sym, yahoo: plan.yahoo, name: plan.name })),
        );
        for (const row of newRows) dbMap.set(String(row.symbol).toLowerCase(), row);
        if (newRows.length) {
          // Cloudflare Workers terminate in-flight async work once the
          // Response is returned unless it's wrapped in ctx.waitUntil.
          // Using `void` here silently dropped the D1 write, which is why
          // the Market page would "flash fresh" on Reload and then revert
          // to the old values after a browser refresh.
          ctx.waitUntil(upsertMarketOverviewRows(env.DB, newRows)
            .catch((e) => console.error("market-overview: D1 write failed", e)));
        }
      }

      // Backfill: make sure cached rows always carry the friendly display
      // name. Older D1 rows were written with the Yahoo slug (^GSPC, GC=F,
      // BTC-USD, ...) as `name`, so a page load can now heal them in-place.
      for (const [sym, plan] of symbolPlan.entries()) {
        const row = dbMap.get(sym);
        if (!row) continue;
        const desired = plan.name;
        if (row.name !== desired) {
          row.name = desired;
        }
      }

      // Build ordered result
      const rows = [...symbolPlan.keys()].map((sym) => dbMap.get(sym)).filter(Boolean);
      return json({ rows, as_of_utc: new Date().toISOString(), refreshing: false });
    }

    // ── /api/stock-detail ────────────────────────────────────────────────────
    if (pathname === "/api/stock-detail" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const range = url.searchParams.get("range") ?? "1y";
      const validRanges = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];
      const rng = validRanges.includes(range) ? range : "1y";

      const yahooSym = toYahooSymbol(symbol);
      if (!yahooSym) return err("Unknown symbol", 404);

      const points = await fetchYahooChart(yahooSym, rng, "1d");
      const series = points.map((p) => ({ date: p.date, close: p.close }));
      const latestClose = series.length ? series[series.length - 1].close : null;
      const firstClose = series.length > 1 ? series[0].close : null;
      const chgPct = latestClose && firstClose ? Math.round((latestClose / firstClose - 1) * 10000) / 100 : null;

      let articles: unknown[] = [];
      const newsTicker = newsTickerForYahooSymbol(yahooSym);
      // Crypto and futures have no Finnhub company news; Yahoo's news
      // search covers them (BTC-USD, GC=F) and needs no key.
      const assetNews = !newsTicker && ASSET_RE.test(yahooSym);
      const newsEnabled = assetNews || Boolean(env.FINNHUB_KEY);
      // The news cache is a nice-to-have: if D1 is unavailable the chart
      // still loads and the news is fetched live.
      const cachedNews = async (key: string, day: string) => {
        try { return await getNewsCacheEntry(env.DB, key, day, 3600); } catch { return null; }
      };
      const saveNews = (key: string, day: string, list: unknown[]) => {
        ctx.waitUntil(upsertNewsCache(env.DB, key, day, list as never)
          .catch((e) => console.error("stock-detail: news cache write failed", e)));
      };
      const todayStr = new Date().toISOString().slice(0, 10);
      if (assetNews) {
        const key = `asset:${yahooSym}`;
        const cached = await cachedNews(key, todayStr);
        if (cached && cached.length) {
          articles = cached;
        } else {
          // Yahoo's news search finds nothing for "BTC-USD" but plenty for
          // "Bitcoin", so crypto is searched by name; futures symbols work.
          let query = yahooSym;
          if (yahooSym.endsWith("-USD")) {
            const hit = (await searchSymbols(yahooSym, 8, "assets"))?.find((r) => r.symbol === yahooSym);
            if (hit) query = hit.name;
          }
          articles = await fetchYahooNews(query, 8);
          if (articles.length) saveNews(key, todayStr, articles);
        }
      } else if (newsEnabled && newsTicker) {
        const fromStr = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
        const cached = await cachedNews(`stock:${newsTicker}`, todayStr);
        if (cached && cached.length) {
          articles = cached;
        } else {
          articles = await fetchCompanyNews(newsTicker, fromStr, todayStr, env.FINNHUB_KEY!);
          if (!articles.length) {
            articles = await fetchYahooNews(newsTicker, 8);
          }
          if (articles.length) saveNews(`stock:${newsTicker}`, todayStr, articles);
        }
      }

      return json({ symbol, yahoo: yahooSym, range: rng, latest_close: latestClose, chg_pct: chgPct, series, news: articles, news_enabled: newsEnabled, has_news: Boolean(newsTicker) || assetNews });
    }

    // ── /api/world-indices ───────────────────────────────────────────────────
    if (pathname === "/api/world-indices" && request.method === "GET") {
      const newsEnabled = Boolean(env.FINNHUB_KEY);
      const todayStr = new Date().toISOString().slice(0, 10);

      const rows = await Promise.allSettled(
        WORLD_INDICES.map(async (meta) => {
          const points = await fetchYahooChart(meta.yahoo, "5d", "1d");
          if (!points.length) return null;
          const last = points[points.length - 1];
          const prev = points.length > 1 ? points[points.length - 2] : null;
          const chg1d = prev ? Math.round((last.close / prev.close - 1) * 10000) / 100 : null;

          let news: unknown[] = [];
          if (newsEnabled && meta.finnhub) {
            const cacheKey = `world:${meta.stooq}`;
            const cached = await getNewsCacheEntry(env.DB, cacheKey, todayStr, 3600);
            if (cached) {
              news = cached;
            } else {
              const from = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
              news = await fetchCompanyNews(meta.finnhub, from, todayStr, env.FINNHUB_KEY!);
              ctx.waitUntil(upsertNewsCache(env.DB, cacheKey, todayStr, news));
            }
          }

          return {
            stooq: meta.stooq, yahoo: meta.yahoo, name: meta.name,
            country: meta.country, iso: meta.iso, lat: meta.lat, lng: meta.lng,
            close: last.close, as_of: last.date, chg_1d_pct: chg1d,
            ok: true, is_sample: false, news, headlines: news,
          };
        }),
      );

      const resultRows = rows.map((r, i) => {
        if (r.status === "fulfilled" && r.value) return r.value;
        const meta = WORLD_INDICES[i];
        return { stooq: meta.stooq, name: meta.name, country: meta.country, iso: meta.iso, lat: meta.lat, lng: meta.lng, ok: false, is_sample: true, close: null, chg_1d_pct: null, news: [], headlines: [] };
      });

      return json({
        rows: resultRows,
        as_of_utc: new Date().toISOString(),
        refreshing: false,
        news_enabled: newsEnabled,
        real_count: resultRows.filter((r) => r.ok && !r.is_sample).length,
        sample_count: resultRows.filter((r) => r.ok && r.is_sample).length,
        total: WORLD_INDICES.length,
        indices_meta: WORLD_INDICES.map((m) => ({ stooq: m.stooq, name: m.name, country: m.country, iso: m.iso })),
      });
    }

    // ── /api/index-history ───────────────────────────────────────────────────
    if (pathname === "/api/index-history" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const rangeKey = url.searchParams.get("range") ?? "1y";
      const meta = getIndexMeta(symbol);
      if (!meta) return err(`Unknown symbol ${symbol}`, 404);

      const yahooRange: Record<string, string> = {
        "1m":  "1mo",
        "3m":  "3mo",
        "6m":  "6mo",
        "1y":  "1y",
        "2y":  "2y",
        "5y":  "5y",
        "all": "max",
      };
      const points = await fetchYahooChart(meta.yahoo, yahooRange[rangeKey] ?? "1y", "1d");

      // Build series with chg_pct (daily % change)
      const series: Array<{ date: string; close: number; chg_pct: number | null }> = [];
      for (let i = 0; i < points.length; i++) {
        const chg = i > 0 ? Math.round((points[i].close / points[i - 1].close - 1) * 10000) / 100 : null;
        series.push({ date: points[i].date, close: points[i].close, chg_pct: chg });
      }

      // Compute significant moves (top 6 by |chg_pct|, gated by 1.5 * stdev)
      const significant: Array<{ date: string; close: number; chg_pct: number; news: unknown[] }> = [];
      if (series.length >= 5) {
        const valid = series
          .map((p, i) => ({ i, abs: p.chg_pct != null ? Math.abs(p.chg_pct) : -1 }))
          .filter((v) => v.abs >= 0);
        valid.sort((a, b) => b.abs - a.abs);
        const topNIdx = new Set(valid.slice(0, 6).map((v) => v.i));

        const vals = valid.map((v) => v.abs);
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1);
        const sd = Math.sqrt(variance);
        const gate = Math.max(1.5, 1.5 * sd);

        let chosenIdx = series
          .map((p, i) => i)
          .filter((i) => topNIdx.has(i) && series[i].chg_pct != null && Math.abs(series[i].chg_pct!) >= gate);

        if (!chosenIdx.length) {
          chosenIdx = valid.slice(0, 3).map((v) => v.i);
        }
        chosenIdx.sort((a, b) => a - b);
        chosenIdx = chosenIdx.slice(0, 8);

        // Fetch news for significant dates if FINNHUB_KEY is set
        const newsEnabled = Boolean(env.FINNHUB_KEY);
        const todayStr = new Date().toISOString().slice(0, 10);
        for (const i of chosenIdx) {
          const p = series[i];
          let dayNews: unknown[] = [];
          if (newsEnabled && meta.finnhub) {
            const dateStr = p.date;
            const cacheKey = `idx-news:${meta.stooq}:${dateStr}`;
            const cached = await getNewsCacheEntry(env.DB, cacheKey, dateStr, 86400);
            if (cached) {
              dayNews = cached;
            } else {
              const from = new Date(new Date(dateStr).getTime() - 1 * 86400 * 1000).toISOString().slice(0, 10);
              const to = new Date(new Date(dateStr).getTime() + 1 * 86400 * 1000).toISOString().slice(0, 10);
              dayNews = await fetchCompanyNews(meta.finnhub, from, to, env.FINNHUB_KEY!);
              dayNews = (dayNews as unknown[]).slice(0, 3);
              ctx.waitUntil(upsertNewsCache(env.DB, cacheKey, dateStr, dayNews));
            }
          }
          significant.push({ date: p.date, close: p.close, chg_pct: p.chg_pct!, news: dayNews });
        }
      }

      return json({
        stooq: meta.stooq, name: meta.name, country: meta.country, range: rangeKey,
        series, significant,
        is_sample: false,
        news_enabled: Boolean(env.FINNHUB_KEY),
      });
    }

    // ── /api/index-news ──────────────────────────────────────────────────────
    if (pathname === "/api/index-news" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const dateStr = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") ?? "5"), 20));
      const meta = getIndexMeta(symbol);

      if (!meta) return err(`Unknown symbol ${symbol}`, 404);
      const newsEnabled = Boolean(env.FINNHUB_KEY);
      if (!newsEnabled || !meta.finnhub) {
        return json({ articles: [], symbol, date: dateStr, news_enabled: newsEnabled });
      }

      const cached = await getNewsCacheEntry(env.DB, `world:${meta.stooq}`, dateStr, 86400);
      if (cached) return json({ articles: (cached as unknown[]).slice(0, limit), symbol, date: dateStr, news_enabled: true });

      const from = new Date(new Date(dateStr).getTime() - 3 * 86400 * 1000).toISOString().slice(0, 10);
      const articles = await fetchCompanyNews(meta.finnhub, from, dateStr, env.FINNHUB_KEY!);
      ctx.waitUntil(upsertNewsCache(env.DB, `world:${meta.stooq}`, dateStr, articles));

      return json({ articles: articles.slice(0, limit), symbol, date: dateStr, news_enabled: true });
    }

    // ── /api/watchlist (GET / POST / DELETE) ────────────────────────────────
    // Used by page 05 (Watchlist) for the user-curated stock repository.
    if (pathname === "/api/watchlist") {
      if (request.method === "GET") {
        const force = url.searchParams.get("refresh") === "1" && (await allowWatchlistRefresh(request, env));
        const symParam = url.searchParams.get("symbols");
        if (symParam !== null) {
          // A signed-in user's personal list: the browser reads it from
          // Supabase and only asks us to score the symbols (no identity needed).
          const syms = [...new Set(
            symParam.split(",").map((s) => s.trim().toUpperCase()).filter((s) => WATCH_SYMBOL_RE.test(s)),
          )].slice(0, MAX_PERSONAL_SYMBOLS);
          const entries: WatchlistRow[] = syms.map((symbol) => ({ symbol, name: null, note: null, added_at: "" }));
          return json(await scoreWatchlist(env, ctx, entries, force, true));
        }
        await seedDefaultWatchlistIfEmpty(env);
        const wl = await getWatchlist(env.DB);
        return json(await scoreWatchlist(env, ctx, wl, force, false));
      }

      if (request.method === "POST") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        let body: { symbol?: string; name?: string; note?: string } = {};
        try { body = await request.json(); } catch { return err("Invalid JSON body"); }
        const sym = (body.symbol || "").trim().toUpperCase();
        if (!sym || !WATCH_SYMBOL_RE.test(sym)) {
          return err("Invalid symbol");
        }
        // Only real listings: "GOOGLE" used to be saved as an empty row.
        const listing = await verifySymbol(sym);
        if (!listing) return err(`No stock or ETF found for "${sym}"`, 404);
        const name = String(body.name || (listing.name !== sym ? listing.name : "") || sym).trim().slice(0, 120);
        await addWatchlistSymbol(
          env.DB, sym, name,
          String(body.note || "").trim().slice(0, 500) || null,
        );
        // Pre-warm metrics so the row shows up populated.
        ctx.waitUntil((async () => {
          const m = await buildWatchMetrics(sym, name, await loadWatchContext(env));
          if (m) await upsertWatchlistMetrics(env.DB, [{ symbol: sym, focus_score: m.focus_score ?? 0, payload: m }]);
        })());
        return json({ ok: true, symbol: sym });
      }

      if (request.method === "DELETE") {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
        if (!sym) return err("Missing symbol");
        await removeWatchlistSymbol(env.DB, sym);
        return json({ ok: true });
      }
    }

    // ── /api/watchlist/refresh ──────────────────────────────────────────────
    if (pathname === "/api/watchlist/refresh" && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const { wrote } = await refreshWatchlistMetrics(env);
      return json({ ok: true, wrote });
    }

    // ── /api/push/test ───────────────────────────────────────────────────────
    // "Send test notification" in the Alerts dialog: pushes the current
    // regime to the caller's own devices only (once a minute per user).
    if (pathname === "/api/push/test" && request.method === "POST") {
      const user = await getSupabaseUser(request, env);
      if (!user) return err("Sign in required", 401);
      if (!pushConfigured(env)) return err("Push isn't configured on the server yet", 503);
      if (!(await allowOncePer(env, `ratelimit:pushtest:${user.id}`, 60))) {
        return err("Please wait a minute before sending another test", 429);
      }
      const targets = await sbSelect<AlertTarget[]>(
        env, `push_subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,endpoint,p256dh,auth`,
      );
      if (!targets.length) return err("No device is subscribed for this account yet", 404);
      const msg = regimeMessage(await currentRegime(env), null);
      const r = await deliver(env, targets, { ...msg, title: `Test · ${msg.title}`, body: "Alerts work on this device." }, "test");
      return json({ ok: r.delivered > 0, devices: targets.length, ...r });
    }

    // ── /api/account (DELETE) ────────────────────────────────────────────────
    // "Delete account" in Settings. Only ever deletes the caller's own account
    // (the id comes from their verified token); data goes with it by cascade.
    if (pathname === "/api/account" && request.method === "DELETE") {
      const user = await getSupabaseUser(request, env);
      if (!user) return err("Sign in required", 401);
      if (!supabaseAdminConfigured(env)) return err("Account deletion isn't configured on the server", 503);
      if (!(await allowOncePer(env, `ratelimit:acctdel:${user.id}`, 30))) {
        return err("Please wait a moment and try again", 429);
      }
      try {
        await sbDeleteUser(env, user.id);
      } catch (e) {
        console.error("delete account:", e);
        return err("Could not delete the account, please try again later", 502);
      }
      return json({ deleted: true });
    }

    // ── /api/me ──────────────────────────────────────────────────────────────
    // Lets the page know whether the signed-in user is the site admin (and so
    // edits the shared watchlist) or a regular user with a personal list.
    if (pathname === "/api/me" && request.method === "GET") {
      const user = await getSupabaseUser(request, env);
      if (!user) return err("Not signed in", 401);
      return json({ email: user.email, admin: isAdmin(user, env) });
    }

    // ── /api/watchlist/reorder ──────────────────────────────────────────────
    // Persist the user's manual drag order. Body: { order: ["NVDA", ...] }.
    if (pathname === "/api/watchlist/reorder" && request.method === "POST") {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const body = await request.json().catch(() => ({})) as { order?: unknown };
      const order = Array.isArray(body.order)
        ? body.order.map((s) => String(s).toUpperCase()).filter(Boolean)
        : [];
      if (order.length) await reorderWatchlist(env.DB, order);
      return json({ ok: true, count: order.length });
    }

    // ── /api/market-timing ──────────────────────────────────────────────────
    // SPY + QQQ trend gauge shown at the top of page 05.
    if (pathname === "/api/market-timing" && request.method === "GET") {
      const settled = await Promise.allSettled([
        buildMarketTiming("SPY", "S&P 500 · SPY"),
        buildMarketTiming("QQQ", "Nasdaq 100 · QQQ"),
        buildMarketTiming("DIA", "Dow 30 · DIA"),
      ]);
      const rows = settled.map((r) => (r.status === "fulfilled" ? r.value : { ok: false }));
      return json({ rows, as_of_utc: new Date().toISOString() });
    }

    // ── /api/market-news ────────────────────────────────────────────────────
    // General market headlines for the News page. Tries Finnhub first, then
    // falls back to Yahoo Finance (no key needed). Cached 30 min in D1; if D1
    // is unavailable the headlines are fetched live.
    if (pathname === "/api/market-news" && request.method === "GET") {
      const todayStr = new Date().toISOString().slice(0, 10);
      const cached = await getNewsCacheEntry(env.DB, "market:general:v2", todayStr, 1800).catch(() => null);
      if (cached && cached.length) return json({ articles: cached, news_enabled: true });

      let articles: unknown[] = [];
      if (env.FINNHUB_KEY) {
        articles = await fetchGeneralNews("general", env.FINNHUB_KEY);
      }
      if (!articles.length) {
        // Aggregate broad-market headlines across a few index queries, then
        // de-duplicate by title and order newest-first.
        const settled = await Promise.allSettled([
          fetchYahooNews("S&P 500", 8),
          fetchYahooNews("Nasdaq", 8),
          fetchYahooNews("Dow Jones", 6),
          fetchYahooNews("Federal Reserve", 6),
        ]);
        const seen = new Set<string>();
        const merged: Array<{ title: string; ts: number }> = [];
        for (const r of settled) {
          if (r.status !== "fulfilled") continue;
          for (const a of r.value) {
            const key = a.title.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(a);
          }
        }
        merged.sort((x, y) => (y.ts || 0) - (x.ts || 0));
        articles = merged.slice(0, 14);
      }
      if (articles.length) {
        ctx.waitUntil(upsertNewsCache(env.DB, "market:general:v2", todayStr, articles)
          .catch((e) => console.error("market-news: cache write failed", e)));
      }
      return json({ articles, news_enabled: true });
    }

    // ── /api/stock-analysis ─────────────────────────────────────────────────
    // Full bars + EMA/volume overlays + pattern annotation for the detail
    // chart on page 05. Symbol here is a raw Yahoo ticker (no .US suffix).
    // Supports daily, weekly and intraday (30m / 60m) timeframes.
    if (pathname === "/api/stock-analysis" && request.method === "GET") {
      const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
      if (!symbol) return err("Missing symbol");

      // Timeframe presets keep the front-end honest about Yahoo's range/
      // interval pairings (intraday windows are short).
      const tf = url.searchParams.get("tf") || "d1y";
      const TF: Record<string, { range: string; interval: string }> = {
        m30: { range: "1mo", interval: "30m" },
        h1:  { range: "3mo", interval: "60m" },
        d6m: { range: "6mo", interval: "1d" },
        d1y: { range: "1y",  interval: "1d" },
        d2y: { range: "2y",  interval: "1d" },
        w1:  { range: "5y",  interval: "1wk" },
      };
      const preset = TF[tf] || TF.d1y;

      const bars = await fetchYahooOHLCV(symbol, preset.range, preset.interval);
      if (!bars.length) return json({ symbol, tf, interval: preset.interval, bars: [], metrics: null });

      const closes = bars.map((b) => b.close);
      const e8 = ema(closes, 8);
      const e21 = ema(closes, 21);
      const e50 = ema(closes, 50);

      // Metrics (ADR/ATR/RSI/patterns/stops) are ALWAYS computed on daily bars
      // over a 2y window, regardless of the chart timeframe, so the swing plan
      // stays consistent when the user flips to weekly / intraday views.
      const [dailyBars, wctx] = await Promise.all([fetchYahooOHLCV(symbol, "2y", "1d"), loadWatchContext(env)]);
      const scored = dailyBars.length ? dailyBars : bars;
      const metrics = computeMetrics(symbol, scored, { ...wctx, lastBarComplete: lastBarComplete(scored) });

      return json({
        symbol, tf, interval: preset.interval,
        bars: bars.map((b, i) => ({
          date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
          ema8: e8[i], ema21: e21[i], ema50: e50[i],
        })),
        metrics,
      });
    }

    // ── /api/refresh (manual trigger, rate-limited per IP: 1 per 10 min) ────
    if (pathname === "/api/refresh" && request.method === "POST") {
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = `ratelimit:refresh:${clientIp}`;
      const COOLDOWN_SECONDS = 10 * 60;

      const prev = await env.DB.prepare(
        "SELECT value FROM kv_store WHERE key = ?"
      ).bind(rlKey).first<{ value: string }>();
      if (prev) {
        const lastTs = parseInt(prev.value, 10) || 0;
        const elapsed = Math.floor(Date.now() / 1000) - lastTs;
        if (elapsed < COOLDOWN_SECONDS) {
          const wait = COOLDOWN_SECONDS - elapsed;
          const h = Math.floor(wait / 3600);
          const m = Math.ceil((wait % 3600) / 60);
          return err(`Rate limited. Try again in ${h}h ${m}m.`, 429);
        }
      }

      const nowTs = String(Math.floor(Date.now() / 1000));
      await env.DB.prepare(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(rlKey, nowTs).run();

      let refreshOk: boolean | string[] = false;
      let errors: string[] = [];
      let wrote = 0;
      try {
        const r = await fetchAllProviders(env);
        refreshOk = r.ok;
        errors = r.err;
        await upsertObservations(env.DB, r.observations);
        wrote = r.observations.length;
      } catch (e) {
        console.error("/api/refresh: fetchAllProviders/upsert failed", e);
        errors = [...errors, String(e)];
      }

      // Also refresh the market_overview cache so the header "Update"
      // button brings Indices / Futures & Crypto / default Stocks
      // forward in addition to the macro indicators.
      let marketWrote = 0;
      try {
        const freshRows = await buildMarketRows(DEFAULT_ITEMS);
        if (freshRows.length) {
          await upsertMarketOverviewRows(env.DB, freshRows);
          marketWrote = freshRows.length;
        }
      } catch (e) {
        console.error("/api/refresh: market_overview refresh failed", e);
        errors = [...errors, `market_overview: ${String(e)}`];
      }

      try { await refreshRegimeSnapshot(env); } catch (e) {
        console.error("/api/refresh: regime snapshot failed", e);
      }

      // Always advance the heartbeat so the UI's "Last Updated" stamp
      // moves even if upstream sources errored.
      try { await setLastCronRun(env.DB); } catch (e) {
        console.error("/api/refresh: setLastCronRun failed", e);
      }
      return json({ ok: refreshOk, err: errors, wrote, market_wrote: marketWrote });
    }

    // ── /api/status ──────────────────────────────────────────────────────────
    if (pathname === "/api/status" && request.method === "GET") {
      const lastUpdate = await getLastUpdateTime(env.DB);
      return json({
        ok: true,
        last_update: lastUpdate,
        news_enabled: Boolean(env.FINNHUB_KEY),
        fred_enabled: Boolean(env.FRED_API_KEY),
      });
    }

    return err("Not found", 404);
  },

  // ── Cron Trigger ─────────────────────────────────────────────────────────
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Each run logs its outbound requests against the free plan's 50.
    const logRequests = (label: string) => ({ requests }: { requests: number | null }) =>
      console.log(`${label}: outbound requests=${requests ?? "n/a"}/50`);
    if (controller.cron === AFTER_CLOSE_CRON) {
      ctx.waitUntil(countSubrequests(() => runAfterCloseJobs(env)).then(logRequests("after-close")));
      return;
    }
    ctx.waitUntil(
      countSubrequests(async () => {
        const t0 = Date.now();
        console.log(`scheduled: tick @ ${new Date().toISOString()}`);

        // 1) Write the heartbeat FIRST. Earlier this lived at the bottom,
        //    so any wall-time/CPU overrun in the upstream fetches would
        //    silently drop the heartbeat write and the dashboard's
        //    "Last Updated" timestamp would never move on a tick that
        //    timed out. Doing it first means the timestamp tracks the
        //    cron schedule itself, not the success of every scraper.
        try {
          await setLastCronRun(env.DB);
          console.log(`scheduled: heartbeat written (+${Date.now() - t0}ms)`);
        } catch (e) {
          console.error("scheduled: setLastCronRun (early) failed", e);
        }

        // 2) Pull every macro provider into D1 (best-effort). Daily sources
        //    are skipped until DAILY_SOURCE_HOURS after their last success.
        try {
          const lastOk = await readJsonKv(env, DAILY_SOURCE_KEY).catch(() => ({} as Record<string, number>));
          const due = (name: string) =>
            !DAILY_SOURCES.has(name) || Date.now() - (lastOk[name] ?? 0) >= DAILY_SOURCE_HOURS * 3600_000;
          const { ok, err, observations, counts } = await fetchAllProviders(env, due);
          await upsertObservations(env.DB, observations);
          const fetchedDaily = [...DAILY_SOURCES].filter((name) => (counts[name] ?? 0) > 0);
          if (fetchedDaily.length) {
            for (const name of fetchedDaily) lastOk[name] = Date.now();
            await writeJsonKv(env, DAILY_SOURCE_KEY, lastOk);
          }
          console.log(
            `scheduled: providers ok=${ok.length} err=${err.length} ` +
              `wrote=${observations.length} daily=[${Object.keys(counts).filter((n) => DAILY_SOURCES.has(n)).join(",")}] (+${Date.now() - t0}ms)`,
          );
          if (err.length) console.error("scheduled: provider errors:", err);
        } catch (e) {
          console.error("scheduled: fetchAllProviders/upsert failed", e);
        }

        // 2b) Re-score the regime on the indicators just stored, then the
        //     regime-change push alerts on that score.
        try {
          const regime = await refreshRegimeSnapshot(env);
          console.log(`scheduled: ${await checkRegimeAlert(env, regime)} (+${Date.now() - t0}ms)`);
        } catch (e) {
          console.error("scheduled: regime / alert failed", e);
        }

        // 3) Refresh the market_overview cache (Indices / Futures & Crypto
        //    / Stocks). Without this, /api/market-overview keeps returning
        //    the first-ever snapshot — the endpoint only re-fetches *missing*
        //    symbols, so rows never age forward until a user hits Reload.
        try {
          const fresh = await buildMarketRows(DEFAULT_ITEMS);   // 2 requests for the 22 rows
          if (fresh.length) await upsertMarketOverviewRows(env.DB, fresh);
          console.log(
            `scheduled: market_overview wrote=${fresh.length} ` +
              `(+${Date.now() - t0}ms)`,
          );
        } catch (e) {
          console.error("scheduled: market_overview refresh failed", e);
        }

        // 3b) Re-score the user watchlist (page 05). This is what lets the
        //     "Special Focus" list surface volume surges, pattern breakouts,
        //     etc. without the user having to open the page first.
        try {
          const open = usMarketWindowOpen();
          const r = await refreshWatchlistMetrics(env, {
            max: WATCHLIST_REFRESH_MAX,
            minAgeSec: open ? WATCHLIST_MIN_AGE_OPEN_SEC : WATCHLIST_MIN_AGE_CLOSED_SEC,
          });
          console.log(`scheduled: watchlist wrote=${r.wrote}/${r.due} of ${r.total} (${open ? "market open" : "market closed"}) signals +${r.added} graded=${r.graded} (+${Date.now() - t0}ms)`);
        } catch (e) {
          console.error("scheduled: watchlist refresh failed", e);
        }

        // 3c) Keep the free-tier Supabase project awake. Supabase pauses free
        //     projects after 7 days without traffic, which would break Google
        //     sign-in after a quiet week. One tiny read a day (03:00 UTC tick).
        const nowUtc = new Date();
        if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY && nowUtc.getUTCHours() === 3 && nowUtc.getUTCMinutes() < 30) {
          try {
            const resp = await fetch(
              `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/watchlist_items?select=symbol&limit=1`,
              { headers: { apikey: env.SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(5000) },
            );
            // 401 is expected (anon can't read the table) and still counts as traffic.
            console.log(`scheduled: supabase keep-alive HTTP ${resp.status}`);
          } catch (e) {
            console.error("scheduled: supabase keep-alive failed", e);
          }
        }

        // 4) Final heartbeat. Most ticks reach here; this updates the
        //    timestamp to the actual *completion* time so the dashboard
        //    "Last Updated" reflects when the latest data really landed.
        try {
          await setLastCronRun(env.DB);
        } catch (e) {
          console.error("scheduled: setLastCronRun (final) failed", e);
        }

        console.log(`scheduled: done in ${Date.now() - t0}ms`);
      }).then(logRequests("scheduled")),
    );
  },
} satisfies ExportedHandler<Env>;
