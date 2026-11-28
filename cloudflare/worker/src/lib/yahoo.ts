export interface YahooChartPoint {
  date: string;
  close: number;
}

interface YahooChartMeta {
  regularMarketPrice?: number | null;
  regularMarketTime?: number | null;
  regularMarketDayHigh?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketVolume?: number | null;
}

interface YahooQuoteArrays {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

interface YahooChartResult {
  meta?: YahooChartMeta;
  timestamp?: number[];
  indicators?: { quote?: YahooQuoteArrays[] };
}

const INTERVAL_UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86400,
  wk: 7 * 86400,
  mo: 31 * 86400,
};

function intervalSeconds(interval: string): number {
  const m = /^(\d+)(m|h|d|wk|mo)$/i.exec(interval.trim());
  if (!m) return 86400;
  return parseInt(m[1], 10) * (INTERVAL_UNIT_SECONDS[m[2].toLowerCase()] ?? 86400);
}

/**
 * Yahoo regularly serves the newest bar with a null `close` even after the
 * session has settled — open/high/low/volume are all present and the settled
 * price is only exposed via `meta.regularMarketPrice`. Since we drop bars
 * without a close, such a response silently pins every exchange-traded symbol
 * one session behind while 24/7 symbols (crypto) keep looking fine. Patch the
 * price back in, but only while the quote timestamp still falls inside that
 * bar's interval so we never attribute a newer print to an older bar.
 */
function patchLastBarFromMeta(result: YahooChartResult, interval: string): void {
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0];
  const meta = result.meta;
  if (!ts?.length || !q?.close || !meta) return;

  const i = ts.length - 1;
  if (q.close[i] != null) return;

  const price = meta.regularMarketPrice;
  const quoteTime = meta.regularMarketTime;
  if (typeof price !== "number" || !Number.isFinite(price)) return;
  if (typeof quoteTime !== "number") return;
  if (quoteTime < ts[i] || quoteTime >= ts[i] + intervalSeconds(interval)) return;

  q.close[i] = price;
  if (q.open && q.open[i] == null) q.open[i] = price;
  if (q.high && q.high[i] == null) q.high[i] = meta.regularMarketDayHigh ?? price;
  if (q.low && q.low[i] == null) q.low[i] = meta.regularMarketDayLow ?? price;
  if (q.volume && q.volume[i] == null) q.volume[i] = meta.regularMarketVolume ?? 0;
}

export interface YahooNewsArticle {
  title: string;
  url: string;
  source: string;
  summary: string;
  datetime: string;
  ts: number;
}

/**
 * Fetch news headlines from Yahoo Finance's public search endpoint. No API key
 * required, so this works as a reliable fallback when Finnhub returns nothing.
 */
export async function fetchYahooNews(query: string, count = 12): Promise<YahooNewsArticle[]> {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", query);
  url.searchParams.set("newsCount", String(count));
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("enableFuzzyQuery", "false");

  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cf: { cacheTtl: 600, cacheEverything: false },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as {
      news?: Array<{
        title?: string; link?: string; publisher?: string;
        providerPublishTime?: number; uuid?: string;
      }>;
    };
    const news = data?.news ?? [];
    const out: YahooNewsArticle[] = [];
    const seen = new Set<string>();
    for (const n of news) {
      const title = (n.title ?? "").trim();
      const link = (n.link ?? "").trim();
      if (!title || !link || seen.has(title)) continue;
      seen.add(title);
      const ts = Number(n.providerPublishTime ?? 0) || 0;
      let iso = "";
      if (ts > 0) { try { iso = new Date(ts * 1000).toISOString(); } catch { /* noop */ } }
      out.push({
        title, url: link, source: (n.publisher ?? "").trim(),
        summary: "", datetime: iso, ts,
      });
      if (out.length >= count) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchYahooChart(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<YahooChartPoint[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");

  const resp = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json",
    },
    cf: { cacheTtl: 300, cacheEverything: false },
  });

  if (!resp.ok) return [];

  try {
    const data = await resp.json() as { chart?: { result?: YahooChartResult[] } };
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    patchLastBarFromMeta(result, interval);
    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];

    const out: YahooChartPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
      out.push({ date: d, close: c });
    }
    return out;
  } catch {
    return [];
  }
}

// Yahoo's spark endpoint answers at most 20 symbols per call.
const SPARK_BATCH = 20;

/**
 * Closes for many symbols at once from Yahoo's spark endpoint: one request
 * per 20 symbols instead of one each, which matters under the free plan's
 * 50 outbound requests per invocation. Same series as fetchYahooChart
 * (checked on all 22 default market rows on 2026-11-28; spark rounds to two
 * decimals), with the same patch for a newest bar that has no close yet.
 * Symbols Yahoo doesn't return are simply missing from the map.
 */
export async function fetchYahooSpark(
  symbols: readonly string[],
  range = "1y",
  interval = "1d",
): Promise<Map<string, YahooChartPoint[]>> {
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_BATCH) batches.push(symbols.slice(i, i + SPARK_BATCH));
  const settled = await Promise.allSettled(batches.map(async (batch) => {
    const url = new URL("https://query1.finance.yahoo.com/v7/finance/spark");
    url.searchParams.set("symbols", batch.join(","));
    url.searchParams.set("range", range);
    url.searchParams.set("interval", interval);
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: false },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`spark HTTP ${resp.status}`);
    return await resp.json() as {
      spark?: { result?: Array<{ symbol?: string; response?: YahooChartResult[] }> };
    };
  }));
  const out = new Map<string, YahooChartPoint[]>();
  for (const r of settled) {
    if (r.status !== "fulfilled") { console.error("fetchYahooSpark:", r.reason); continue; }
    for (const item of r.value?.spark?.result ?? []) {
      const result = item.response?.[0];
      if (!item.symbol || !result) continue;
      patchLastBarFromMeta(result, interval);
      const ts = result.timestamp ?? [];
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      const points: YahooChartPoint[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (c == null) continue;
        points.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
      }
      if (points.length) out.set(item.symbol, points);
    }
  }
  return out;
}

export interface YahooQuote {
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
}

/** Fetch a single current quote (latest close, 1d change) from Yahoo Finance. */
export async function fetchYahooQuote(symbol: string): Promise<YahooQuote | null> {
  const points = await fetchYahooChart(symbol, "5d", "1d");
  if (!points.length) return null;
  return points[points.length - 1];
}

export interface YahooBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch full OHLCV daily bars from Yahoo Finance. Unlike fetchYahooChart
 * (which only keeps `close`), this preserves open/high/low/volume so the
 * Watchlist page can compute range/volatility/volume metrics and draw
 * candlesticks.
 */
export async function fetchYahooOHLCV(
  symbol: string,
  range = "1y",
  interval = "1d",
): Promise<YahooBar[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");

  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: false },
  });
  if (!resp.ok) return [];

  try {
    const data = await resp.json() as { chart?: { result?: YahooChartResult[] } };
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    patchLastBarFromMeta(result, interval);
    const ts = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const opens = q.open ?? [];
    const highs = q.high ?? [];
    const lows = q.low ?? [];
    const closes = q.close ?? [];
    const vols = q.volume ?? [];

    // Intraday intervals (e.g. 30m, 60m, 1h, 90m) need the time-of-day kept
    // on the label; daily / weekly / monthly only need the calendar date.
    const isIntraday = /\d+\s*m$|h$/i.test(interval) && interval !== "1mo" && interval !== "3mo";

    const out: YahooBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      const h = highs[i];
      const l = lows[i];
      const o = opens[i];
      if (c == null || h == null || l == null || o == null) continue;
      const iso = new Date(ts[i] * 1000).toISOString();
      out.push({
        date: isIntraday ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10),
        open: o, high: h, low: l, close: c,
        volume: vols[i] ?? 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}
