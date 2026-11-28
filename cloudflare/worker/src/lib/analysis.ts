import type { YahooBar } from "./yahoo";
import { ema, r2 } from "./indicators";
import { EMPTY_PATTERN, PATTERN_CODES, detectPatterns } from "./patterns";
import type { PatternResult } from "./patterns";
import { detectSetups } from "./setups";
import type { Setup } from "./setups";

export { ema };
export { toWeekly } from "./patterns";
export type { PatternResult } from "./patterns";
export type { Setup } from "./setups";

// ── Generic indicator helpers ────────────────────────────────────────────────

/** Wilder's RSI of the closing series. Returns the latest value (or null). */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range over the last `period` bars (simple mean of TR). */
export function atr(bars: YahooBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** Average Daily Range as a percentage: mean of (high/low - 1) over `period`. */
export function adrPct(bars: YahooBar[], period = 20): number | null {
  if (bars.length < 2) return null;
  const slice = bars.slice(-period).filter((b) => b.low > 0);
  if (!slice.length) return null;
  const sum = slice.reduce((s, b) => s + (b.high / b.low - 1), 0);
  return (sum / slice.length) * 100;
}

function pctChange(cur: number, prev: number | null | undefined): number | null {
  if (prev == null || prev === 0) return null;
  return Math.round((cur / prev - 1) * 10000) / 100;
}

// ── Full metric bundle for one symbol ────────────────────────────────────────

export interface WatchMetrics {
  symbol: string;
  price: number | null;
  as_of: string | null;
  chg_1d_pct: number | null;
  chg_1w_pct: number | null;
  chg_1m_pct: number | null;
  chg_3m_pct: number | null;
  chg_6m_pct: number | null;
  lod: number | null;
  hod: number | null;
  adr_pct: number | null;
  atr: number | null;
  atr_pct: number | null;
  rsi: number | null;
  ema8: number | null;
  ema21: number | null;
  ema50: number | null;
  vol_today: number | null;
  vol_avg_1m: number | null;
  vol_ratio: number | null;
  vol_doubled: boolean;
  hve: boolean;
  extended: boolean;
  dollar_vol: number | null;
  pattern_label: string | null;
  pattern_labels: string[];
  pattern_tf: "daily" | "weekly" | null;
  pattern_matches: PatternResult[];
  pivot: number | null;
  // Trade plan. `entry` is the setup trigger, the base's pivot, or (with
  // neither) today's price; the stop is structural (signal-day low, or the
  // pivot less one ATR), at most 7–8% under the entry.
  plan_kind: "setup" | "breakout" | "generic" | null;
  plan_label: string | null;
  entry: number | null;
  stop: number | null;
  stop_pct: number | null;
  risk: number | null;
  tp_2r: number | null;   // +2R: move the stop to breakeven
  tp1: number | null;     // +3R
  tp2: number | null;     // +5R
  setups: Setup[];
  hold_hints: string[];   // if you already hold it: TRIM_8, EXIT_21, NO_ADD
  rs_6m: number | null;   // 6-month change minus SPY's, in points
  stress: number | null;  // regime v2 stress count used for this score
  focus_score: number;
  focus_reasons: string[];
  pattern: PatternResult;
  ok: boolean;
}

export interface MetricsContext {
  /** False while today's session is still trading (the last bar is partial). */
  lastBarComplete?: boolean;
  /** Regime v2 stress count; at 2 or more pullback setups don't score. */
  stress?: number | null;
  /** SPY's 6-month change in %, for the relative-strength tag. */
  spy6m?: number | null;
}

// Special Focus weights, from the 2018–2026 backtest on ~600 liquid stocks
// (docs/algorithm-v2-plan.md, section 3). Setups and the few bases that kept
// an edge score; everything else is shown as a tag but adds nothing.
// Volume surges are tags only: they helped only in hindsight (the day's full
// volume isn't known when the pivot trades).
const SETUP_POINTS: Record<string, number> = { EP: 5, TIGHT_PB: 4, PB21: 3 };
const BASE_POINTS: Record<string, number> = {
  HTF: 4, CUP: 3, CUP_HANDLE: 3, BULL_FLAG: 1, BULL_FLAG_W: 2, PENNANT_W: 2,
};
export const FOCUS_MIN = 4;

export function computeMetrics(symbol: string, bars: YahooBar[], ctx: MetricsContext = {}): WatchMetrics {
  const base: WatchMetrics = {
    symbol,
    price: null, as_of: null,
    chg_1d_pct: null, chg_1w_pct: null, chg_1m_pct: null, chg_3m_pct: null, chg_6m_pct: null,
    lod: null, hod: null, adr_pct: null, atr: null, atr_pct: null, rsi: null,
    ema8: null, ema21: null, ema50: null,
    vol_today: null, vol_avg_1m: null, vol_ratio: null, vol_doubled: false,
    hve: false, extended: false, dollar_vol: null,
    pattern_label: null, pattern_labels: [], pattern_tf: null, pattern_matches: [], pivot: null,
    plan_kind: null, plan_label: null, entry: null,
    stop: null, stop_pct: null, risk: null, tp_2r: null, tp1: null, tp2: null,
    setups: [], hold_hints: [], rs_6m: null, stress: ctx.stress ?? null,
    focus_score: 0, focus_reasons: [],
    pattern: { ...EMPTY_PATTERN },
    ok: false,
  };
  const n = bars.length;
  if (n < 2) return base;

  const last = bars[n - 1];
  const closes = bars.map((b) => b.close);
  const price = last.close;

  base.ok = true;
  base.price = r2(price);
  base.as_of = last.date;
  base.lod = r2(last.low);
  base.hod = r2(last.high);

  base.chg_1d_pct = pctChange(price, closes[n - 2]);
  base.chg_1w_pct = pctChange(price, closes[n - 6]);
  base.chg_1m_pct = pctChange(price, closes[n - 22]);
  base.chg_3m_pct = pctChange(price, closes[n - 64]);
  base.chg_6m_pct = pctChange(price, closes[n - 127]);

  base.adr_pct = round2OrNull(adrPct(bars, 20));
  const a = atr(bars, 14);
  base.atr = round2OrNull(a);
  base.atr_pct = a != null && price ? r2((a / price) * 100) : null;
  base.rsi = round2OrNull(rsi(closes, 14));

  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  base.ema8 = r2(e8[n - 1]);
  base.ema21 = r2(e21[n - 1]);
  base.ema50 = r2(e50[n - 1]);

  const volToday = last.volume || 0;
  const priorVols = bars.slice(Math.max(0, n - 22), n - 1).map((b) => b.volume || 0).filter((v) => v > 0);
  const volAvg = priorVols.length ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : null;
  base.vol_today = volToday || null;
  base.vol_avg_1m = volAvg != null ? Math.round(volAvg) : null;
  base.vol_ratio = volAvg && volAvg > 0 ? r2(volToday / volAvg) : null;
  base.vol_doubled = (base.vol_ratio ?? 0) >= 2;
  base.dollar_vol = volAvg != null ? Math.round(volAvg * price) : null;

  const maxVol = Math.max(...bars.map((b) => b.volume || 0));
  base.hve = volToday > 0 && volToday >= maxVol;

  if (a != null && base.ema50 != null) {
    base.extended = price >= base.ema50 + 7 * a;
  }

  const { best: pat, all: matches } = detectPatterns(bars);
  base.pattern = pat;
  base.pattern_matches = matches;
  base.pattern_label = pat.label;
  base.pattern_labels = matches.map((p) => p.label ?? "").filter(Boolean);
  base.pattern_tf = pat.timeframe;
  base.pivot = pat.pivot;

  if (ctx.spy6m != null && base.chg_6m_pct != null) base.rs_6m = r2(base.chg_6m_pct - ctx.spy6m);

  // ── Setups and the trade plan ─────────────────────────────────────────────
  const lastBarComplete = ctx.lastBarComplete ?? true;
  base.setups = detectSetups(bars, { lastBarComplete, stress: ctx.stress });
  const scoringSetups = base.setups.filter((x) => !(x.code === "PB21" && x.stress_warning));
  const lead = [...scoringSetups, ...base.setups]
    .sort((x, y) => (SETUP_POINTS[y.code] ?? 0) - (SETUP_POINTS[x.code] ?? 0))[0];

  // A base still to break out: price under the pivot, pivot within 10%.
  const inReach = (p: PatternResult) => p.pivot != null && price < p.pivot && p.pivot <= price * 1.10;
  const baseCode = (p: PatternResult) =>
    p.kind ? PATTERN_CODES[p.kind] + (p.timeframe === "weekly" ? "_W" : "") : "";
  const bases = matches.filter(inReach).sort((x, y) => (BASE_POINTS[baseCode(y)] ?? 0) - (BASE_POINTS[baseCode(x)] ?? 0));
  const leadBase = bases[0] ?? null;

  let entry: number | null = null;
  let stop: number | null = null;
  if (lead) {
    base.plan_kind = "setup";
    base.plan_label = lead.label;
    entry = lead.entry_type === "close" ? price : lead.trigger;
    stop = lead.stop;
  } else if (leadBase && leadBase.pivot != null) {
    base.plan_kind = "breakout";
    base.plan_label = `${leadBase.label} breakout`;
    entry = leadBase.pivot;
    stop = Math.max(entry - (a ?? entry * 0.07), entry * 0.93);
  } else if (price > 0) {
    // No setup or base: generic levels from today's price, as before.
    const candidates = [7];
    if (base.adr_pct != null && base.adr_pct > 0) candidates.push(base.adr_pct);
    if (base.atr_pct != null && base.atr_pct > 0) candidates.push(base.atr_pct);
    base.plan_kind = "generic";
    base.plan_label = "No setup";
    entry = price;
    stop = price * (1 - Math.min(...candidates) / 100);
  }
  if (entry != null && stop != null && stop < entry) {
    const riskAmt = entry - stop;
    base.entry = r2(entry);
    base.stop = r2(stop);
    base.stop_pct = r2((riskAmt / entry) * 100);
    base.risk = r2(riskAmt);
    base.tp_2r = r2(entry + 2 * riskAmt);
    base.tp1 = r2(entry + 3 * riskAmt);
    base.tp2 = r2(entry + 5 * riskAmt);
  }

  // If you already hold it: first close under the 8 / 21 EMA, or extended.
  const prevClose = closes[n - 2];
  if (prevClose != null && n >= 3) {
    if (price < e8[n - 1] && prevClose >= e8[n - 2]) base.hold_hints.push("TRIM_8");
    if (price < e21[n - 1] && (prevClose >= e21[n - 2] || closes[n - 3] >= e21[n - 3])) base.hold_hints.push("EXIT_21");
  }
  if (base.extended) base.hold_hints.push("NO_ADD");

  // ── Special Focus score ───────────────────────────────────────────────────
  let score = 0;
  const reasons: string[] = [];
  for (const x of base.setups) {
    if (!reasons.includes(x.code)) reasons.push(x.code);
    if (x.stress_warning && !reasons.includes("STRESS")) reasons.push("STRESS");
    if (x.code === "PB21" && x.stress_warning) continue;   // lost money under stress
    score += x === lead ? (SETUP_POINTS[x.code] ?? 0) : 1;
  }
  if (leadBase) score += BASE_POINTS[baseCode(leadBase)] ?? 0;
  for (const p of matches) {
    const code = baseCode(p);
    if (code && !reasons.includes(code)) reasons.push(code);
  }
  if (score > 0 && (base.adr_pct ?? 0) >= 4) { score += 1; reasons.push("ADR4"); }
  // Tags only (no points): volume, trend, relative strength, extension.
  if (base.vol_doubled) reasons.push("VOL_DOUBLED");
  else if ((base.vol_ratio ?? 0) >= 1.5) reasons.push("VOL_SURGE");
  if (base.hve) reasons.push("HVE");
  if ((base.rs_6m ?? -Infinity) >= 10) reasons.push("RS_LEAD");
  if ((base.chg_1m_pct ?? 0) >= 30) reasons.push("STRONG_1M");
  if (base.ema8 != null && base.ema21 != null && base.ema50 != null &&
      base.ema8 > base.ema21 && base.ema21 > base.ema50) reasons.push("TREND_UP");
  if (base.extended) reasons.push("EXTENDED");
  base.focus_score = score;
  base.focus_reasons = reasons;

  return base;
}

function round2OrNull(v: number | null): number | null {
  return v == null || Number.isNaN(v) ? null : r2(v);
}
