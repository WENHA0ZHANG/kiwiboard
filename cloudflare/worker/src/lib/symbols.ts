import { fetchYahooQuote } from "./yahoo";

// ── Ticker / company-name lookup for the "add a stock" boxes ────────────────
// People type "google" or "apple" as often as "GOOG". Yahoo Finance's public
// search endpoint maps both to listings; only stocks and ETFs are offered,
// US listings (no ".XX" exchange suffix) first. Results are kept in memory
// per isolate: the Cache API is a no-op on workers.dev.

export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;          // display name, e.g. "NASDAQ"
  type: "EQUITY" | "ETF";
}

export const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

const ALLOWED_TYPES = new Set(["EQUITY", "ETF"]);
const HIT_TTL_MS = 24 * 3600 * 1000;
const MISS_TTL_MS = 60 * 1000;       // Yahoo sometimes answers a burst with nothing
const MAX_ENTRIES = 500;
const memo = new Map<string, { at: number; ttl: number; value: SymbolMatch[] }>();

interface YahooSearchQuote {
  symbol?: string; shortname?: string; longname?: string;
  exchange?: string; exchDisp?: string; quoteType?: string;
}

/**
 * Search Yahoo for stocks/ETFs matching a ticker or company name.
 * Returns null only when Yahoo could not be reached at all.
 */
export async function searchSymbols(query: string, limit = 8): Promise<SymbolMatch[] | null> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const cached = memo.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) return cached.value;

  let answered = false;
  let quotes: YahooSearchQuote[] = [];
  // Retry on the second host when the first fails or comes back empty.
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = new URL(`https://${host}/v1/finance/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("quotesCount", "15");
    url.searchParams.set("newsCount", "0");
    url.searchParams.set("listsCount", "0");
    url.searchParams.set("enableFuzzyQuery", "false");
    try {
      const resp = await fetch(url.toString(), {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) continue;
      const data = await resp.json() as { quotes?: YahooSearchQuote[] };
      answered = true;
      quotes = data?.quotes ?? [];
      if (quotes.length) break;
    } catch { /* try the next host */ }
  }
  if (!answered) return null;

  const out: SymbolMatch[] = [];
  const seen = new Set<string>();
  for (const q of quotes) {
    const symbol = String(q.symbol ?? "").trim().toUpperCase();
    const type = String(q.quoteType ?? "").toUpperCase();
    if (!symbol || seen.has(symbol) || !ALLOWED_TYPES.has(type) || !TICKER_RE.test(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      name: String(q.longname || q.shortname || symbol).trim(),
      exchange: String(q.exchDisp || q.exchange || "").trim(),
      type: type as SymbolMatch["type"],
    });
  }
  // US listings first; otherwise keep Yahoo's relevance order (sort is stable).
  out.sort((a, b) => Number(a.symbol.includes(".")) - Number(b.symbol.includes(".")));
  const value = out.slice(0, limit);

  if (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  memo.set(key, { at: Date.now(), ttl: value.length ? HIT_TTL_MS : MISS_TTL_MS, value });
  return value;
}

// "apple" → "Apple Inc.", "coca cola" → "The Coca-Cola Company": the query is
// the start of the name and ends on a word boundary ("micro" ≠ "Microsoft").
function nameStartsWith(name: string, query: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
  const n = norm(name);
  const q = norm(query);
  return q.length >= 3 && (n === q || n.startsWith(q + " "));
}

// A ticker the search didn't list (new listings, odd share classes) still
// counts when Yahoo has prices for it.
async function hasPrices(symbol: string): Promise<boolean> {
  try { return Boolean(await fetchYahooQuote(symbol)); } catch { return false; }
}

/** The one listing a symbol means, or null if Yahoo doesn't know it. */
export async function verifySymbol(symbol: string): Promise<SymbolMatch | null> {
  const sym = symbol.trim().toUpperCase();
  if (!TICKER_RE.test(sym)) return null;
  const listed = (await searchSymbols(sym))?.find((r) => r.symbol === sym);
  if (listed) return listed;
  return (await hasPrices(sym)) ? { symbol: sym, name: sym, exchange: "", type: "EQUITY" } : null;
}

/**
 * What a typed text clearly means, if anything: an exact ticker ("nvda"), or
 * a company name that one US listing starts with ("apple" → AAPL). When the
 * two disagree ("ford": FORD is Forward Industries, Ford Motor is F) or the
 * name only loosely matches ("google" → Alphabet), the caller lets the user
 * pick from the list instead.
 */
export async function resolveSymbol(
  query: string,
  results: SymbolMatch[] | null,
): Promise<{ match: SymbolMatch; how: "symbol" | "name" } | null> {
  const upper = query.trim().toUpperCase();
  const list = results ?? [];
  let bySymbol: SymbolMatch | null = list.find((r) => r.symbol === upper) ?? null;
  if (!bySymbol && TICKER_RE.test(upper) && (await hasPrices(upper))) {
    bySymbol = { symbol: upper, name: upper, exchange: "", type: "EQUITY" };
  }
  // Share classes are usually written "BRK.B"; Yahoo's symbol is "BRK-B".
  if (!bySymbol && /^[A-Z]{1,6}\.[A-Z]$/.test(upper)) bySymbol = await verifySymbol(upper.replace(".", "-"));
  const top = list.find((r) => !r.symbol.includes("."));
  const byName = top && nameStartsWith(top.name, query) ? top : null;
  if (bySymbol && byName && bySymbol.symbol !== byName.symbol) return null;
  if (bySymbol) return { match: bySymbol, how: "symbol" };
  if (byName) return { match: byName, how: "name" };
  return null;
}
