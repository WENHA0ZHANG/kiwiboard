import type { YahooBar } from "./yahoo";
import { ema, r2 } from "./indicators";

// ── Daily buy setups (Watchlist v2) ──────────────────────────────────────────
// Three entries that kept an edge in the 2018–2026 backtest of ~600 liquid
// US stocks (research/backtest/bt_setups.py; numbers in
// docs/algorithm-v2-plan.md, section 3.3). Each one forms on a finished
// daily bar and gives a price to buy at, a stop under the signal day's low
// and a risk of at most 8%. Generic textbook definitions; no proprietary
// methodology is reproduced.
//
//  • EP gap: opens ≥ 8% above the prior close on ≥ 3× the 50-day volume and
//    holds above the open, without a big run in the prior six months.
//    Bought at the close of the gap day (or, the day after, above its high).
//  • Tight pullback: a stock that ran ≥ 25% in a month drops ≥ 8% in six
//    days into its rising 8/21-day EMAs and prints a narrow-range day.
//  • 21 EMA pullback: an uptrending stock eases back to its rising 21-day
//    EMA on light volume. Lost money when market stress was 2 or more.

export type SetupKind = "ep" | "ep_day2" | "tight_pullback" | "ema21_pullback";
export type SetupCode = "EP" | "TIGHT_PB" | "PB21";

export interface Setup {
  kind: SetupKind;
  code: SetupCode;
  label: string;
  signal_date: string;          // the bar the setup formed on
  entry_type: "close" | "stop"; // buy at the close, or a buy-stop above `trigger`
  trigger: number;
  stop: number;
  risk_pct: number;
  // forming: EP still trading (buy near the close if it holds)
  // ready: waiting for the next session to trade above the trigger
  // triggered: the session after the signal traded above the trigger
  state: "forming" | "ready" | "triggered";
  entry: number | null;         // fill price once triggered
  stress_warning: boolean;      // market stress ≥ 2: pullbacks lost money then (EP held up)
  note: string;
}

export interface SetupContext {
  /** False while today's session is still trading (the last bar is partial). */
  lastBarComplete: boolean;
  /** Regime v2 stress count (rates, MOVE, HY, NFCI, SKEW), if known. */
  stress?: number | null;
}

const MAX_RISK = 0.08;
const MIN_DOLLAR_VOL = 2e7;   // the backtest only traded names with ≥ $20M a day
const MIN_PRICE = 10;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}

/** Bar-level features at index t, matching research/backtest/bt_common.py. */
function featuresAt(bars: YahooBar[], t: number) {
  const c = bars.map((b) => b.close);
  const trs: number[] = [];
  for (let i = Math.max(1, t - 13); i <= t; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const adrSlice = bars.slice(Math.max(0, t - 19), t + 1).filter((b) => b.low > 0);
  const v50Slice = bars.slice(Math.max(0, t - 50), t).map((b) => b.volume || 0);
  const dv = bars.slice(Math.max(0, t - 19), t + 1).map((b) => (b.volume || 0) * b.close);
  const ret = (i: number, k: number) => (i - k >= 0 && c[i - k] > 0 ? (c[i] / c[i - k] - 1) * 100 : NaN);
  return {
    atr: mean(trs),
    adr: adrSlice.length ? mean(adrSlice.map((b) => b.high / b.low - 1)) * 100 : NaN,
    v50: v50Slice.length >= 20 ? mean(v50Slice) : NaN,
    dv20: mean(dv),
    r6m: (i: number) => ret(i, 126),
    r1m: (i: number) => ret(i, 21),
  };
}

function plan(
  kind: SetupKind, code: SetupCode, label: string, bars: YahooBar[], t: number,
  entryType: "close" | "stop", trigger: number, stop: number, note: string,
): Omit<Setup, "state" | "entry" | "stress_warning"> | null {
  if (!(stop < trigger) || (trigger - stop) / trigger > MAX_RISK + 1e-9) return null;
  return {
    kind, code, label, signal_date: bars[t].date, entry_type: entryType,
    trigger: r2(trigger), stop: r2(stop), risk_pct: r2((1 - stop / trigger) * 100), note,
  };
}

/**
 * Setups on the last finished bar. While today's session is still trading,
 * that is yesterday's bar and today's bar shows whether the trigger traded;
 * an EP gap is also flagged on today's bar as it forms.
 */
export function detectSetups(bars: YahooBar[], ctx: SetupContext): Setup[] {
  const n = bars.length;
  if (n < 140) return [];
  const t = ctx.lastBarComplete ? n - 1 : n - 2;
  const today = ctx.lastBarComplete ? null : bars[n - 1];
  const closes = bars.map((b) => b.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const stressed = (ctx.stress ?? 0) >= 2;
  const out: Setup[] = [];

  const finish = (p: ReturnType<typeof plan>, warn = false): void => {
    if (!p) return;
    let state: Setup["state"] = "ready";
    let entry: number | null = null;
    if (today && p.entry_type === "stop" && today.high > p.trigger) {
      state = "triggered";
      entry = r2(Math.max(p.trigger, today.open));
    }
    out.push({ ...p, state, entry, stress_warning: warn });
  };

  const f = featuresAt(bars, t);
  const b = bars[t];
  const liquid = f.dv20 >= MIN_DOLLAR_VOL && b.close >= MIN_PRICE;
  if (liquid) {
    // EP gap on the finished bar: tomorrow, buy above the gap day's high.
    const prevR6 = f.r6m(t - 1);
    if (b.open >= closes[t - 1] * 1.08 && b.volume >= 3 * f.v50 && b.close >= b.open && !(prevR6 > 30)) {
      const trig = b.high;
      finish(plan("ep_day2", "EP", "EP gap · day 2", bars, t, "stop", trig, Math.max(b.low, trig * 0.92),
        `Gapped ${((b.open / closes[t - 1] - 1) * 100).toFixed(0)}% on ${(b.volume / f.v50).toFixed(1)}× volume; buy above the gap day's high`));
    }

    // Tight pullback into the rising 8/21 EMAs after a ≥ 25% month.
    const runUp = f.r1m(t - 5);
    const sharp = closes[t] / Math.max(...closes.slice(t - 6, t)) - 1;
    const tight = ((b.high - b.low) / b.close) * 100 <= 0.6 * f.adr;
    if (runUp >= 25 && f.adr >= 4 && e21[t] > e21[t - 5] && sharp <= -0.08 &&
        closes[t] >= e21[t] * 0.97 && closes[t] <= e8[t] * 1.03 && tight) {
      finish(plan("tight_pullback", "TIGHT_PB", "Tight pullback", bars, t, "stop", b.high, b.low,
        `Ran ${runUp.toFixed(0)}% in a month, fell ${Math.abs(sharp * 100).toFixed(0)}% into the 8/21 EMAs, then a narrow day`),
        stressed);
    }

    // Light-volume pullback to a rising 21 EMA.
    const up = e8[t] > e21[t] && e21[t] > e50[t] && e50[t] > e50[t - 10] && closes[t] > e50[t];
    const drop = closes[t] / Math.max(...closes.slice(t - 5, t)) - 1;
    const atrPct = f.atr / b.close;
    const quietVol = mean(bars.slice(t - 2, t + 1).map((x) => x.volume || 0)) < f.v50;
    if (up && f.r6m(t) >= 15 && drop <= -1.5 * atrPct && b.low <= e21[t] * 1.01 && closes[t] >= e21[t] * 0.98 && quietVol) {
      finish(plan("ema21_pullback", "PB21", "21 EMA pullback", bars, t, "stop", b.high, b.low,
        "Eased back to the rising 21 EMA on light volume"), stressed);
    }
  }

  // EP forming today: gap and volume already there; buy near the close if
  // it still holds above the open (the best-tested version of the trade).
  if (today) {
    const ft = featuresAt(bars, n - 1);
    const prev = closes[n - 2];
    const liquidToday = ft.dv20 >= MIN_DOLLAR_VOL && today.close >= MIN_PRICE;
    if (liquidToday && today.open >= prev * 1.08 && today.volume >= 3 * ft.v50 && today.close >= today.open && !(ft.r6m(n - 2) > 30)) {
      const p = plan("ep", "EP", "EP gap", bars, n - 1, "close", today.close, Math.max(today.low, today.close * 0.92),
        `Gapped ${((today.open / prev - 1) * 100).toFixed(0)}% on ${(today.volume / ft.v50).toFixed(1)}× volume so far; buy near the close if it holds above the open`);
      if (p) out.push({ ...p, state: "forming", entry: null, stress_warning: false });
    }
  }
  return out;
}
