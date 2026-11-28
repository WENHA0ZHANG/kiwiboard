import type { D1Database } from "@cloudflare/workers-types";
import type { YahooBar } from "./yahoo";
import type { WatchMetrics } from "./analysis";
import { FOCUS_MIN } from "./analysis";
import { ema, r2 } from "./indicators";

// ── Signal log (Watchlist v2, Phase 3) ──────────────────────────────────────
// Every setup and Special Focus base on the shared watchlist is written to
// D1 once, then graded from the daily bars each time the cron refreshes the
// symbol, with the same two exits as the backtest (research/backtest/
// bt_common.py `simulate`):
//   plan:  +3R target, −1R stop, out after 30 sessions
//   trend: stop to breakeven after a close at +2R, out on a close below the
//          21 EMA, at most 60 sessions
// Unlike the backtest this has no survivorship bias: it is the live record.

export type SignalSetup = "EP" | "TIGHT_PB" | "PB21" | "BASE";
export type SignalStatus = "pending" | "missed" | "open" | "closed";

export interface SignalRow {
  id?: number;
  symbol: string;
  setup: SignalSetup;
  label: string;
  signal_date: string;
  entry_type: "close" | "stop";
  trigger: number;
  stop: number;
  window: number;              // sessions the trigger stays valid
  status: SignalStatus;
  entry_date: string | null;
  entry: number | null;
  exit_date: string | null;
  r_plan: number | null;
  r_trend: number | null;
  r_now: number | null;        // latest close in R while open
  max_r: number | null;        // best close in R so far
  stress: number | null;
  updated_at?: string;
}

const MIN_DOLLAR_VOL = 2e7;
const MIN_PRICE = 10;

/** New signals worth logging from a fresh metrics row (finished bars only). */
export function signalsFromMetrics(m: WatchMetrics, bars: YahooBar[], lastBarComplete: boolean): SignalRow[] {
  const out: SignalRow[] = [];
  const base = (fields: Partial<SignalRow> & Pick<SignalRow, "setup" | "label" | "signal_date" | "entry_type" | "trigger" | "stop" | "window">): SignalRow => ({
    symbol: m.symbol, status: "pending", entry_date: null, entry: null, exit_date: null,
    r_plan: null, r_trend: null, r_now: null, max_r: null, stress: m.stress ?? null, ...fields,
  });
  for (const x of m.setups) {
    if (x.state === "forming") continue;              // logged once its bar has closed
    if (x.code === "PB21" && x.stress_warning) continue;
    if (x.code === "EP") {
      // Logged as the buy-at-close trade the page flagged while it formed.
      const bar = bars.find((b) => b.date === x.signal_date);
      if (!bar) continue;
      out.push(base({
        setup: "EP", label: "EP gap", signal_date: x.signal_date, entry_type: "close",
        trigger: r2(bar.close), stop: r2(Math.max(bar.low, bar.close * 0.92)), window: 0,
      }));
    } else {
      out.push(base({
        setup: x.code, label: x.label, signal_date: x.signal_date, entry_type: "stop",
        trigger: x.trigger, stop: x.stop, window: 1,
      }));
    }
  }
  // A Special Focus base whose pivot is within reach: buy-stop at the pivot
  // for the next five sessions.
  if (!out.length && m.plan_kind === "breakout" && m.focus_score >= FOCUS_MIN &&
      m.entry != null && m.stop != null && (m.dollar_vol ?? 0) >= MIN_DOLLAR_VOL && (m.price ?? 0) >= MIN_PRICE) {
    const t = lastBarComplete ? bars.length - 1 : bars.length - 2;
    if (t >= 0) {
      out.push(base({
        setup: "BASE", label: m.plan_label ?? "Base breakout", signal_date: bars[t].date, entry_type: "stop",
        trigger: m.entry, stop: m.stop, window: 5,
      }));
    }
  }
  return out;
}

/**
 * Re-grade one signal from the symbol's daily bars. Only finished bars are
 * used, so a partial session never closes a trade. Returns the updated row.
 */
export function gradeSignal(sig: SignalRow, allBars: YahooBar[], lastBarComplete: boolean): SignalRow {
  const bars = lastBarComplete ? allBars : allBars.slice(0, -1);
  const n = bars.length;
  const t = bars.findIndex((b) => b.date === sig.signal_date);
  if (t < 0) return sig;
  const c = bars.map((b) => b.close);
  const e21 = ema(c, 21);

  // 1) Entry.
  let j = -1;
  let entry = 0;
  if (sig.entry_type === "close") {
    j = t; entry = c[t];
  } else {
    // Bases fill at the pivot itself; setups need a trade above the signal high.
    const hit = (h: number) => (sig.setup === "BASE" ? h >= sig.trigger : h > sig.trigger);
    for (let k = t + 1; k <= Math.min(n - 1, t + sig.window); k++) {
      if (hit(bars[k].high)) { j = k; entry = Math.max(sig.trigger, bars[k].open); break; }
    }
    if (j < 0) {
      // Not triggered: still pending until its window of sessions has passed.
      return n - 1 >= t + sig.window ? { ...sig, status: "missed" } : { ...sig, status: "pending" };
    }
  }
  const stop = sig.stop;
  const risk = entry - stop;
  if (!(risk > 0)) return { ...sig, status: "missed" };
  const R = (px: number) => r2((px - entry) / risk);
  const atClose = sig.entry_type === "close";

  // 2) Plan exit: +3R / −1R / 30 sessions.
  let rPlan: number | null = null;
  let planExit = -1;
  const tgt = entry + 3 * risk;
  if (!atClose && c[j] <= stop) { rPlan = R(c[j]); planExit = j; }
  else if (!atClose && bars[j].high >= tgt) { rPlan = 3; planExit = j; }
  else {
    for (let k = j + 1; k < Math.min(n, j + 31); k++) {
      const b = bars[k];
      if (b.open <= stop) { rPlan = R(b.open); planExit = k; break; }
      if (b.low <= stop) { rPlan = -1; planExit = k; break; }
      if (b.open >= tgt) { rPlan = R(b.open); planExit = k; break; }
      if (b.high >= tgt) { rPlan = 3; planExit = k; break; }
    }
    if (rPlan == null && n - 1 >= j + 30) { rPlan = R(c[j + 30]); planExit = j + 30; }
  }

  // 3) Trend exit: breakeven after +2R, close below the 21 EMA, 60 sessions.
  let rTrend: number | null = null;
  let trendExit = -1;
  let st = stop;
  if (!atClose && c[j] <= stop) { rTrend = R(c[j]); trendExit = j; }
  else {
    for (let k = j + 1; k < Math.min(n, j + 61); k++) {
      const b = bars[k];
      if (b.open <= st) { rTrend = R(b.open); trendExit = k; break; }
      if (b.low <= st) { rTrend = R(st); trendExit = k; break; }
      if (c[k] >= entry + 2 * risk) st = Math.max(st, entry);
      if (c[k] < e21[k] && k > j + 1) { rTrend = R(c[k]); trendExit = k; break; }
    }
    if (rTrend == null && n - 1 >= j + 60) { rTrend = R(c[j + 60]); trendExit = j + 60; }
  }

  const last = Math.max(planExit, trendExit);
  const closed = rPlan != null && rTrend != null;
  let maxR = -Infinity;
  for (let k = j; k <= (closed ? last : n - 1); k++) maxR = Math.max(maxR, (c[k] - entry) / risk);
  return {
    ...sig,
    status: closed ? "closed" : "open",
    entry_date: bars[j].date,
    entry: r2(entry),
    exit_date: closed ? bars[last].date : null,
    r_plan: rPlan,
    r_trend: rTrend,
    r_now: closed ? null : R(c[n - 1]),
    max_r: Number.isFinite(maxR) ? r2(maxR) : null,
  };
}

// ── D1 ───────────────────────────────────────────────────────────────────────

const COLS = [
  "symbol", "setup", "label", "signal_date", "entry_type", "trigger", "stop", "window", "status",
  "entry_date", "entry", "exit_date", "r_plan", "r_trend", "r_now", "max_r", "stress",
] as const;

/** Signals still waiting for a trigger or in a trade (a handful of rows). */
export async function getActiveSignals(db: D1Database): Promise<SignalRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM signal_log WHERE status IN ('pending','open')`,
  ).all<SignalRow>();
  return rows.results;
}

export async function insertSignals(db: D1Database, rows: SignalRow[]): Promise<void> {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await db.batch(rows.map((r) => db.prepare(
    `INSERT OR IGNORE INTO signal_log (${COLS.join(",")}, created_at, updated_at)
     VALUES (${COLS.map(() => "?").join(",")}, ?, ?)`,
  ).bind(...COLS.map((k) => r[k] ?? null), now, now)));
}

export async function updateSignals(db: D1Database, rows: SignalRow[]): Promise<void> {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await db.batch(rows.map((r) => db.prepare(
    `UPDATE signal_log SET status = ?, entry_date = ?, entry = ?, exit_date = ?, r_plan = ?, r_trend = ?,
       r_now = ?, max_r = ?, updated_at = ? WHERE id = ?`,
  ).bind(r.status, r.entry_date, r.entry, r.exit_date, r.r_plan, r.r_trend, r.r_now, r.max_r, now, r.id ?? -1)));
}

export async function recentSignals(db: D1Database, limit = 20): Promise<SignalRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM signal_log WHERE status != 'missed' ORDER BY signal_date DESC, id DESC LIMIT ?`,
  ).bind(limit).all<SignalRow>();
  return rows.results;
}

/** Fields that change when a signal is re-graded. */
export function signalChanged(a: SignalRow, b: SignalRow): boolean {
  return a.status !== b.status || a.entry !== b.entry || a.r_plan !== b.r_plan || a.r_trend !== b.r_trend ||
    a.r_now !== b.r_now || a.max_r !== b.max_r || a.exit_date !== b.exit_date;
}
