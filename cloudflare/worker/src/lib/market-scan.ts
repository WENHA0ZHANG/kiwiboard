import type { D1Database } from "@cloudflare/workers-types";
import type { WatchMetrics } from "./analysis";
import { FOCUS_MIN } from "./analysis";
import { NDX_MEMBERS } from "./breadth";
import { nyClock } from "./market-clock";
import { SP500_MEMBERS } from "./sp500";

// ── Daily market scan (Watchlist v2, Phase 4) ───────────────────────────────
// After each US close a GitHub Actions job (cloudflare/scan/market-scan.ts)
// runs this Worker's own rules (computeMetrics, detectSetups) on every stock
// in SCAN_UNIVERSE. The names that would make the Trade Plan go into the D1
// table `market_scan`, and a status row into kv_store; /api/market-scan
// serves the latest scan to the Watchlist page.

/** S&P 500 and Nasdaq 100 members, the backtest's universe (≈ 520 names). */
export const SCAN_UNIVERSE: readonly string[] = [...new Set([...SP500_MEMBERS, ...NDX_MEMBERS])].sort();

export const SCAN_STATUS_KEY = "market_scan:last";
/** Scans older than this many days are deleted when a new one is stored. */
export const SCAN_KEEP_DAYS = 90;
/** "Scan stale" once more than this many sessions have closed since the last scan. */
export const SCAN_STALE_SESSIONS = 2;

const MIN_DOLLAR_VOL = 2e7;   // the backtest's liquidity floor, as in signal-log.ts
const MIN_PRICE = 10;

export interface ScanCandidate {
  symbol: string;
  score: number;               // Special Focus score (≥ 4 is Special Focus)
  setup: "EP" | "TIGHT_PB" | "PB21" | "BASE";
  label: string;
  entry_type: "close" | "stop";
  state: "ready" | "triggered" | "forming";
  buy: number;                 // setup trigger or base pivot (the close for an EP bought at the close)
  stop: number;
  risk_pct: number;
  stress: boolean;             // a pullback under market stress ≥ 2: shown, but it doesn't score
  price: number | null;
  chg_1d_pct: number | null;
  adr_pct: number | null;
  tags: string[];              // focus_reasons
}

export interface ScanStatus {
  scan_date: string;           // the finished session that was scanned
  finished_at: string;         // ISO time
  universe: number;
  scanned: number;             // symbols with bars for that session
  failed: number;              // no bars after retries
  candidates: number;
  logged: number;              // new signal_log rows (source "scan")
  graded: number;              // "scan" rows re-graded
  stress: number | null;       // regime v2 stress count the scores used
  seconds: number;
}

/**
 * The scan's entry for one stock, or null: the same choice as the Trade Plan
 * card makes for a watchlist name. Its lead setup (a pullback paused by
 * market stress only when it is the only one), else a Special Focus base
 * whose pivot is within reach.
 */
export function scanCandidate(m: WatchMetrics): ScanCandidate | null {
  if (!m.ok || m.price == null) return null;
  const common = {
    symbol: m.symbol, score: m.focus_score, price: m.price, chg_1d_pct: m.chg_1d_pct,
    adr_pct: m.adr_pct, tags: m.focus_reasons,
  };
  const setups = m.setups ?? [];
  const lead = setups.find((x) => !(x.code === "PB21" && x.stress_warning)) ?? setups[0];
  if (lead) {
    const buy = lead.entry_type === "close" ? m.price : lead.trigger;
    return {
      ...common, setup: lead.code, label: lead.label, entry_type: lead.entry_type, state: lead.state,
      buy, stop: lead.stop, risk_pct: lead.risk_pct, stress: lead.stress_warning,
    };
  }
  const liquid = (m.dollar_vol ?? 0) >= MIN_DOLLAR_VOL && m.price >= MIN_PRICE;
  if (m.plan_kind === "breakout" && m.focus_score >= FOCUS_MIN && liquid &&
      m.entry != null && m.stop != null && m.stop_pct != null) {
    return {
      ...common, setup: "BASE", label: m.plan_label ?? "Base breakout", entry_type: "stop", state: "ready",
      buy: m.entry, stop: m.stop, risk_pct: m.stop_pct, stress: false,
    };
  }
  return null;
}

/** Page order: paused pullbacks last, then the highest score, then the widest daily range. */
export function sortCandidates(rows: ScanCandidate[]): ScanCandidate[] {
  return [...rows].sort((a, b) =>
    Number(a.stress) - Number(b.stress) || b.score - a.score ||
    (b.adr_pct ?? 0) - (a.adr_pct ?? 0) || (a.symbol < b.symbol ? -1 : 1));
}

const isWeekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;

/**
 * Weekday sessions closed since `scanDate`, up to `now` in New York. Today
 * counts from 20:00, which leaves the after-close job (and its retry) time to
 * run. Market holidays count as sessions; the stale threshold allows for it.
 */
export function sessionsSince(scanDate: string, now = new Date()): number {
  const ny = nyClock(now);
  const start = Date.parse(scanDate + "T00:00:00Z");
  const today = Date.parse(ny.date + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(today)) return 0;
  let n = 0;
  for (let t = start + 864e5; t <= today; t += 864e5) {
    if (!isWeekday(new Date(t))) continue;
    if (t === today && ny.minutes < 20 * 60) continue;
    n++;
  }
  return n;
}

export interface MarketScanResponse {
  status: ScanStatus | null;
  stale: boolean;
  sessions_behind: number | null;
  rows: ScanCandidate[];
}

/** The latest stored scan: one kv row plus that day's candidates (a few dozen rows). */
export async function getMarketScan(db: D1Database, now = new Date()): Promise<MarketScanResponse> {
  const kv = await db.prepare("SELECT value FROM kv_store WHERE key = ?").bind(SCAN_STATUS_KEY)
    .first<{ value: string }>();
  let status: ScanStatus | null = null;
  try { status = kv ? JSON.parse(kv.value) as ScanStatus : null; } catch { status = null; }
  if (!status?.scan_date) return { status: null, stale: true, sessions_behind: null, rows: [] };

  const res = await db.prepare("SELECT payload_json FROM market_scan WHERE scan_date = ?")
    .bind(status.scan_date).all<{ payload_json: string }>();
  const rows: ScanCandidate[] = [];
  for (const r of res.results) {
    try { rows.push(JSON.parse(r.payload_json) as ScanCandidate); } catch { /* skip a bad row */ }
  }
  const behind = sessionsSince(status.scan_date, now);
  return { status, stale: behind > SCAN_STALE_SESSIONS, sessions_behind: behind, rows: sortCandidates(rows) };
}
