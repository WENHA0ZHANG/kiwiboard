import type { MarketRegime, Observation, Signal, StressInput } from "./types";
import { isStale } from "./freshness";

// Stress-input rows (regime v2). Their readings come from the regime
// snapshot, which has the history a 20-day change needs.
const STRESS_ROWS: Partial<Record<StressInput["id"], { title: string; rule: string }>> = {
  rates: { title: "Rate Shock: 10-Year Real or Nominal Yield", rule: "real +0.25 pp or 10Y +0.40 pp in 20 days: top" },
  move: { title: "MOVE Bond Volatility Index", rule: "≥ 110: top" },
  nfci: { title: "Chicago Fed Financial Conditions (NFCI)", rule: "+0.05 in 4 weeks: top" },
  narrow: { title: "Narrow Market: S&P 500 Near Its High", rule: "within 2% of the high, < 55% of members above the 50-day MA: top" },
};

/**
 * Bull / bear signal per indicator, with the same rules as the regime (v2):
 * the greed-level "tops" it dropped (low VIX, high RSI, strong breadth,
 * tight HY spreads) only count as bottoms here too, and the stress inputs
 * get rows of their own when the regime snapshot is passed in.
 */
export function computeSignals(
  latest: Record<string, Observation>,
  now: Date = new Date(),
  regime: MarketRegime | null = null,
): Signal[] {
  const out: Signal[] = [];
  const stress = new Map((regime?.stress ?? []).map((x) => [x.id, x]));

  // 1) CNN Fear & Greed
  const fg = latest["cnn_fear_greed_index"];
  if (fg) {
    const v = fg.value;
    let meta: Record<string, unknown> | undefined;
    try { meta = fg.meta_json ? JSON.parse(fg.meta_json) : undefined; } catch { /* noop */ }
    out.push({
      indicator_id: "cnn_fear_greed_index",
      top: v >= 75,
      bottom: v <= 25,
      title: "Fear & Greed Index",
      detail: `${v.toFixed(1)} (≥ 75 extreme greed; ≤ 25 extreme fear)`,
      meta: meta ?? null,
    });
  }

  // 2) CNN Put/Call
  const pc = latest["cnn_put_call_options"];
  if (pc) {
    const v = pc.value;
    out.push({
      indicator_id: "cnn_put_call_options",
      top: v < 0.55,
      bottom: v >= 0.95,
      title: "Put/Call Ratio (5-Day Average)",
      detail: `${v.toFixed(2)} (< 0.55 extreme greed; ≥ 0.95 panic put-buying)`,
    });
  }

  // 3) VIX
  const vix = latest["vix"];
  if (vix) {
    const v = vix.value;
    out.push({
      indicator_id: "vix",
      top: false,
      bottom: v > 25,
      title: "S&P 500 Volatility Index",
      detail: `${v.toFixed(2)} (> 25 fear, > 30 panic: bottom)`,
    });
  }

  // 4) S&P 500 RSI
  const rsi = latest["sp500_rsi"];
  if (rsi) {
    const v = rsi.value;
    out.push({
      indicator_id: "sp500_rsi",
      top: false,
      bottom: v <= 30,
      title: "S&P 500 Relative Strength Index",
      detail: `${v.toFixed(2)} (≤ 30 oversold: bottom)`,
    });
  }

  // 5) S&P 500 PE
  const sppe = latest["sp500_pe_ratio"];
  if (sppe) {
    const v = sppe.value;
    out.push({
      indicator_id: "sp500_pe_ratio",
      top: v >= 31,
      bottom: v <= 25,
      title: "S&P 500 Price-to-Earnings Ratio",
      detail: `${v.toFixed(2)}x (≥ 31 top valuation; ≤ 25 bottom valuation)`,
    });
  }

  // 6) Nasdaq 100 PE
  const ndxpe = latest["nasdaq100_pe_ratio"];
  if (ndxpe) {
    const v = ndxpe.value;
    out.push({
      indicator_id: "nasdaq100_pe_ratio",
      top: v >= 30,
      bottom: v <= 26,
      title: "Nasdaq 100 Price-to-Earnings Ratio",
      detail: `${v.toFixed(2)}x (≥ 30 top valuation; ≤ 26 bottom valuation)`,
    });
  }

  // 7) Nasdaq 100 > 20d MA
  const ndtw = latest["nasdaq100_above_20d_ma"];
  if (ndtw) {
    const v = ndtw.value;
    out.push({
      indicator_id: "nasdaq100_above_20d_ma",
      top: false,
      bottom: v < 20,
      title: "Nasdaq 100 Above 20-Day Moving Average (%)",
      detail: `${v.toFixed(2)}% (< 20 broad selloff: bottom)`,
    });
  }

  // 8) HY OAS
  const hy = latest["us_high_yield_spread"];
  if (hy) {
    const raw = hy.value;
    const bp = (hy.unit === "percent" || raw < 30) ? raw * 100 : raw;
    const pct = bp / 100;
    const widening = stress.get("hy_widening");
    out.push({
      indicator_id: "us_high_yield_spread",
      top: (widening?.tier ?? 0) > 0,
      bottom: bp > 400,
      title: "US High Yield Option-Adjusted Spread",
      detail: `${pct.toFixed(2)}%${widening?.detail ? `, ${widening.detail}` : ""} ` +
        "(+40 bp in 20 days or +60 bp over the 60-day low: top; > 4.0%: bottom)",
    });
  }

  // 9) CBOE SKEW
  const skew = latest["cboe_skew"];
  if (skew) {
    const v = skew.value;
    out.push({
      indicator_id: "cboe_skew",
      top: v >= 150,
      bottom: v <= 135,
      title: "CBOE SKEW (Tail-Risk Hedging)",
      detail: `${v.toFixed(1)} (≥ 150 tail hedging: top; ≤ 135 low hedging: bottom)`,
    });
  }

  // 10) 10Y-2Y Yield Curve
  const yc = latest["yc_10y_2y"];
  if (yc) {
    const v = yc.value;
    out.push({
      indicator_id: "yc_10y_2y",
      top: v >= -0.05 && v <= 0.6,
      bottom: v >= 1.5,
      title: "10Y-2Y Treasury Yield Curve",
      detail: `${v >= 0 ? "+" : ""}${v.toFixed(2)}% (re-steepening from inversion: late-cycle top window; ≥ 1.5% Fed-easing-driven bottom window)`,
    });
  }

  // A reading too old to trust neither fires nor counts; the detail says why.
  for (const s of out) {
    const o = latest[s.indicator_id];
    if (o && isStale(o, now)) {
      s.top = false;
      s.bottom = false;
      s.stale = true;
      s.detail = `No reading since ${o.as_of}, not used. ${s.detail}`;
    }
  }

  // 11–14) Stress inputs that have no indicator row of their own.
  for (const [id, row] of Object.entries(STRESS_ROWS) as Array<[StressInput["id"], { title: string; rule: string }]>) {
    const x = stress.get(id);
    if (!x) continue;
    const quiet = Boolean(x.stale || x.missing);
    out.push({
      indicator_id: `stress_${id}`,
      top: !quiet && x.tier > 0,
      bottom: false,
      title: row.title,
      detail: quiet ? `${x.reason}. (${row.rule})` : `${x.detail} (${row.rule})`,
      ...(quiet ? { stale: true } : {}),
    });
  }

  return out;
}
