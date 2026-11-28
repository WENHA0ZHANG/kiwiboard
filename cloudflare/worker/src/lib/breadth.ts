import type { Observation } from "./types";

// ── Nasdaq 100 % above the 20-day moving average, computed from Yahoo ───────
// Barchart's $NDTW page stopped answering scripts (HTTP 202, empty body) in
// September 2026, so the breadth reading froze at 2026-09-02. Computing it
// from the members' daily closes tracks Barchart closely: over 101 shared
// days the two series correlated 0.94 with a 2.2-point mean gap.

// Nasdaq-100 members on 2026-11-28 (Wikipedia, "List of NASDAQ-100
// companies"). The index is reconstituted every December and changes now
// and then in between, so refresh this list after each reconstitution.
export const NDX_MEMBERS: readonly string[] = [
  "ADBE", "AMD", "ABNB", "ALNY", "GOOGL", "GOOG", "AMZN", "AEP", "AMGN", "ADI",
  "AAPL", "AMAT", "APP", "ARM", "ASML", "ALAB", "ADSK", "ADP", "AXON", "BKR",
  "BKNG", "AVGO", "CDNS", "CTAS", "CSCO", "CCEP", "CMCSA", "CEG", "CPRT", "CRWV",
  "COST", "CRWD", "CSX", "DDOG", "DXCM", "FANG", "DASH", "EXC", "FAST", "FER",
  "FTNT", "GEHC", "GILD", "HONA", "HON", "IDXX", "INTC", "INTU", "ISRG", "KDP",
  "KLAC", "LRCX", "LIN", "LITE", "MAR", "MRVL", "MELI", "META", "MCHP", "MU",
  "MSFT", "MSTR", "MRNA", "MDLZ", "MPWR", "MNST", "NBIS", "NFLX", "NVDA", "NXPI",
  "ORLY", "ODFL", "PCAR", "PLTR", "PANW", "PAYX", "PYPL", "PDD", "PEP", "QCOM",
  "REGN", "RKLB", "ROP", "ROST", "SNDK", "STX", "SHOP", "SPCX", "SBUX", "SNPS",
  "TMUS", "TTWO", "TER", "TSLA", "TXN", "TRI", "VRTX", "WMT", "WDC", "WDAY",
  "XEL",
];

const SPARK_BATCH = 20;       // Yahoo's spark endpoint answers at most 20 symbols per call
const SMA_DAYS = 20;
const MIN_MEMBERS = 90;       // skip a day when too few members have a full 20-day window
const KEEP_DAYS = 70;         // days written per run; refills gaps of about three months

type Closes = Map<string, number>; // trading date → close

/** Daily closes for up to 20 symbols per request from Yahoo's spark endpoint. */
async function fetchSparkCloses(symbols: readonly string[], range: string): Promise<Map<string, Closes>> {
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += SPARK_BATCH) batches.push(symbols.slice(i, i + SPARK_BATCH));
  const out = new Map<string, Closes>();
  const settled = await Promise.allSettled(batches.map(async (batch) => {
    const url = new URL("https://query1.finance.yahoo.com/v7/finance/spark");
    url.searchParams.set("symbols", batch.join(","));
    url.searchParams.set("range", range);
    url.searchParams.set("interval", "1d");
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`spark HTTP ${resp.status}`);
    return await resp.json() as {
      spark?: { result?: Array<{ symbol?: string; response?: Array<{
        timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }> }> };
    };
  }));
  for (const r of settled) {
    if (r.status !== "fulfilled") { console.error("fetchSparkCloses:", r.reason); continue; }
    for (const item of r.value?.spark?.result ?? []) {
      const resp = item.response?.[0];
      const ts = resp?.timestamp ?? [];
      const closes = resp?.indicators?.quote?.[0]?.close ?? [];
      if (!item.symbol || !ts.length) continue;
      const series: Closes = new Map();
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === "number" && c > 0) series.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
      }
      out.set(item.symbol, series);
    }
  }
  return out;
}

/**
 * Share of members closing above their simple moving average, for every date
 * on which at least `minMembers` of them have a full window. Oldest first.
 */
export function percentAboveSma(
  bySymbol: Map<string, Closes>,
  period = SMA_DAYS,
  minMembers = MIN_MEMBERS,
): Array<{ date: string; pct: number; members: number }> {
  const above = new Map<string, number>();
  const counted = new Map<string, number>();
  for (const series of bySymbol.values()) {
    const dates = [...series.keys()].sort();
    let sum = 0;
    for (let i = 0; i < dates.length; i++) {
      sum += series.get(dates[i])!;
      if (i >= period) sum -= series.get(dates[i - period])!;
      if (i < period - 1) continue;
      const d = dates[i];
      counted.set(d, (counted.get(d) ?? 0) + 1);
      if (series.get(d)! > sum / period) above.set(d, (above.get(d) ?? 0) + 1);
    }
  }
  return [...counted.entries()]
    .filter(([, n]) => n >= minMembers)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, n]) => ({ date, pct: Math.round(((above.get(date) ?? 0) / n) * 10000) / 100, members: n }));
}

/** NDX % above the 20-day SMA for the last KEEP_DAYS trading days. */
export async function fetchNdxBreadth(): Promise<Observation[]> {
  const closes = await fetchSparkCloses(NDX_MEMBERS, "6mo");
  const days = percentAboveSma(closes).slice(-KEEP_DAYS);
  if (!days.length) {
    console.error(`fetchNdxBreadth: no usable days (${closes.size} of ${NDX_MEMBERS.length} members returned)`);
    return [];
  }
  const insertedAt = new Date().toISOString().slice(0, 10);
  return days.map((d) => ({
    indicator_id: "nasdaq100_above_20d_ma",
    as_of: d.date,
    value: d.pct,
    unit: "percent",
    source: "Yahoo (computed)",
    meta_json: JSON.stringify({
      method: `% of Nasdaq-100 members closing above their ${SMA_DAYS}-day SMA`,
      members: d.members,
    }),
    inserted_at: insertedAt,
  }));
}
