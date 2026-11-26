import { fetchYahooQuote } from "./yahoo";

// ── Ticker / company-name lookup for the "add" boxes ───────────────────────
// People type "google" or "apple" as often as "GOOG". Yahoo Finance's public
// search endpoint maps both to listings. Two kinds of lookup:
//   stocks — stocks and ETFs, US listings (no ".XX" exchange suffix) first;
//   assets — crypto priced in US dollars (ETH-USD) and futures (GC=F), for
//            the Futures & Crypto table.
// Results are kept in memory per isolate: the Cache API is a no-op on
// workers.dev.

export type SymbolKind = "stocks" | "assets";

export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;          // e.g. "NASDAQ"; "Crypto" or "Futures" for assets
  type: "EQUITY" | "ETF" | "CRYPTOCURRENCY" | "FUTURE";
}

export const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
export const ASSET_RE = /^[A-Z0-9]{1,10}(?:-USD|=F)$/;

const KIND_TYPES: Record<SymbolKind, Set<string>> = {
  stocks: new Set(["EQUITY", "ETF"]),
  assets: new Set(["CRYPTOCURRENCY", "FUTURE"]),
};

// "Gold Dec 26" → "Gold", "Micro Gold Futures,Dec-2026" → "Micro Gold",
// "Ethereum USD" → "Ethereum": the contract month and the quote currency
// only add noise next to a symbol that already says it.
export function cleanAssetName(name: string, type: string): string {
  const n = type === "CRYPTOCURRENCY"
    ? name.replace(/\s+USD$/i, "")
    : name.replace(/,\s*[A-Z][a-z]{2}(?:-\d{0,4})?$/, "")
        .replace(/\s+[A-Z][a-z]{2}\s+\d{2}$/, "")
        .replace(/\s+Futures?$/i, "");
  return n.trim() || name.trim();
}

// Short label for the Futures & Crypto table: ETH-USD → ETH, CL=F → CL.
export function assetLabel(symbol: string): string {
  return symbol.toUpperCase().replace(/-USD$/, "").replace(/=F$/, "");
}
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
export async function searchSymbols(
  query: string,
  limit = 8,
  kind: SymbolKind = "stocks",
): Promise<SymbolMatch[] | null> {
  if (!query.trim()) return [];
  const key = `${kind}:${query.trim().toLowerCase()}`;
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

  const allowed = KIND_TYPES[kind];
  const symbolRe = kind === "assets" ? ASSET_RE : TICKER_RE;
  const out: SymbolMatch[] = [];
  const seen = new Set<string>();
  for (const q of quotes) {
    const symbol = String(q.symbol ?? "").trim().toUpperCase();
    const type = String(q.quoteType ?? "").toUpperCase();
    if (!symbol || seen.has(symbol) || !allowed.has(type) || !symbolRe.test(symbol)) continue;
    seen.add(symbol);
    const name = String(q.longname || q.shortname || symbol).trim();
    out.push({
      symbol,
      name: kind === "assets" ? cleanAssetName(name, type) : name,
      exchange: kind === "assets"
        ? (type === "FUTURE" ? "Futures" : "Crypto")
        : String(q.exchDisp || q.exchange || "").trim(),
      type: type as SymbolMatch["type"],
    });
  }
  // Stocks: US listings first; otherwise keep Yahoo's relevance order (the
  // sort is stable).
  if (kind === "stocks") {
    out.sort((a, b) => Number(a.symbol.includes(".")) - Number(b.symbol.includes(".")));
  }
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
  kind: SymbolKind = "stocks",
): Promise<{ match: SymbolMatch; how: "symbol" | "name" } | null> {
  if (kind === "assets") return resolveAsset(query, results);
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

// Crypto / futures: "ETH-USD" or "GC=F" typed in full, a bare code ("eth"
// → ETH-USD, spot before the ETH=F future; "cl" → CL=F), or a name the top
// result starts with ("gold" → GC=F, "bitcoin" → BTC-USD).
function resolveAsset(
  query: string,
  results: SymbolMatch[] | null,
): { match: SymbolMatch; how: "symbol" | "name" } | null {
  const upper = query.trim().toUpperCase().replace(/\s+/g, "");
  const list = results ?? [];
  const find = (sym: string) => list.find((r) => r.symbol === sym) ?? null;
  const bySymbol = find(upper) ?? find(`${upper}-USD`) ?? find(`${upper}=F`);
  const top = list[0];
  const byName = top && nameStartsWith(top.name, query) ? top : null;
  if (bySymbol && byName && bySymbol.symbol !== byName.symbol) return null;
  if (bySymbol) return { match: bySymbol, how: "symbol" };
  if (byName) return { match: byName, how: "name" };
  return null;
}
