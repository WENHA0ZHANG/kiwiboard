import type { Observation, MarketRegime, MarketRegimeV2, RegimeContribution, StressInput } from "./types";
import { ALL_INDICATOR_IDS } from "./types";
import { MAX_AGE_DAYS, ageDays, isStale } from "./freshness";

const WEIGHTS: Record<string, number> = {
  vix: 1.5,
  us_high_yield_spread: 1.5,
  sp500_pe_ratio: 1.2,
  cnn_fear_greed_index: 1.0,
  cnn_put_call_options: 1.0,
  nasdaq100_above_20d_ma: 1.0,
  yc_10y_2y: 1.0,
  sp500_rsi: 0.7,
  nasdaq100_pe_ratio: 0.7,
  cboe_skew: 0.6,
};

const BANDS: [number, string, string][] = [
  [9.0,  "Strong Buy",   "regime-strong-buy"],
  [4.5,  "Buy",          "regime-buy"],
  [1.5,  "Cautious Buy", "regime-cautious-buy"],
  [-1.5, "Neutral",      "regime-neutral"],
  [-4.5, "Caution",      "regime-caution"],
  [-9.0, "Risk",         "regime-risk"],
  [-Infinity, "Strong Risk", "regime-strong-risk"],
];

function scoreOne(
  o: Observation,
  recentlyInverted: boolean,
): RegimeContribution | null {
  const id = o.indicator_id;
  const v = o.value;
  const w = WEIGHTS[id] ?? 1.0;

  function c(title: string, value: number, unit: string, tier: number, reason: string): RegimeContribution {
    return { indicator_id: id, title, value, unit, tier, weight: w, points: Math.round(tier * w * 100) / 100, reason };
  }

  if (id === "vix") {
    if (v >= 40) return c("VIX", v, "", +3, `VIX ${v.toFixed(1)} ≥ 40 panic capitulation`);
    if (v >= 30) return c("VIX", v, "", +2, `VIX ${v.toFixed(1)} > 30 fear`);
    if (v > 25)  return c("VIX", v, "", +1, `VIX ${v.toFixed(1)} > 25 elevated fear`);
    if (v < 12)  return c("VIX", v, "", -2, `VIX ${v.toFixed(1)} < 12 extreme complacency`);
    if (v < 14)  return c("VIX", v, "", -1, `VIX ${v.toFixed(1)} < 14 complacency`);
    return c("VIX", v, "", 0, "VIX in normal range");
  }

  if (id === "cnn_fear_greed_index") {
    if (v <= 10) return c("Fear & Greed", v, "", +3, `F&G ${v.toFixed(0)} ≤ 10 capitulation`);
    if (v <= 20) return c("Fear & Greed", v, "", +2, `F&G ${v.toFixed(0)} ≤ 20 extreme fear`);
    if (v <= 25) return c("Fear & Greed", v, "", +1, `F&G ${v.toFixed(0)} ≤ 25 fear`);
    if (v >= 85) return c("Fear & Greed", v, "", -2, `F&G ${v.toFixed(0)} ≥ 85 extreme greed`);
    if (v >= 75) return c("Fear & Greed", v, "", -1, `F&G ${v.toFixed(0)} ≥ 75 greed`);
    return c("Fear & Greed", v, "", 0, "F&G in normal range");
  }

  if (id === "cnn_put_call_options") {
    if (v >= 1.20) return c("Put/Call (5d)", v, "", +3, `P/C ${v.toFixed(2)} ≥ 1.20 panic put-buying`);
    if (v >= 1.05) return c("Put/Call (5d)", v, "", +2, `P/C ${v.toFixed(2)} ≥ 1.05 heavy put-buying`);
    if (v >= 0.95) return c("Put/Call (5d)", v, "", +1, `P/C ${v.toFixed(2)} ≥ 0.95 elevated fear`);
    if (v < 0.50)  return c("Put/Call (5d)", v, "", -2, `P/C ${v.toFixed(2)} < 0.50 extreme call greed`);
    if (v < 0.55)  return c("Put/Call (5d)", v, "", -1, `P/C ${v.toFixed(2)} < 0.55 call greed`);
    return c("Put/Call (5d)", v, "", 0, "P/C in normal range");
  }

  if (id === "sp500_rsi") {
    if (v < 25)  return c("S&P 500 RSI", v, "", +2, `RSI ${v.toFixed(1)} < 25 deeply oversold`);
    if (v < 30)  return c("S&P 500 RSI", v, "", +1, `RSI ${v.toFixed(1)} < 30 oversold`);
    if (v > 80)  return c("S&P 500 RSI", v, "", -2, `RSI ${v.toFixed(1)} > 80 deeply overbought`);
    if (v > 70)  return c("S&P 500 RSI", v, "", -1, `RSI ${v.toFixed(1)} > 70 overbought`);
    return c("S&P 500 RSI", v, "", 0, "RSI in normal range");
  }

  if (id === "us_high_yield_spread") {
    const bp = (o.unit === "bp" || v > 30) ? v : v * 100;
    const pct = bp / 100;
    if (bp >= 700) return c("HY OAS", pct, "%", +3, `HY ${pct.toFixed(2)}% ≥ 7% credit panic`);
    if (bp >= 550) return c("HY OAS", pct, "%", +2, `HY ${pct.toFixed(2)}% ≥ 5.5% credit stress`);
    if (bp >= 400) return c("HY OAS", pct, "%", +1, `HY ${pct.toFixed(2)}% ≥ 4.0% credit stress`);
    if (bp <= 250) return c("HY OAS", pct, "%", -2, `HY ${pct.toFixed(2)}% ≤ 2.5% credit complacency`);
    if (bp <= 270) return c("HY OAS", pct, "%", -1, `HY ${pct.toFixed(2)}% ≤ 2.7% credit-greed`);
    return c("HY OAS", pct, "%", 0, "HY OAS in normal range");
  }

  if (id === "nasdaq100_above_20d_ma") {
    if (v < 10)  return c("NDX > 20d MA", v, "%", +2, `${v.toFixed(0)}% < 10 broad capitulation`);
    if (v < 20)  return c("NDX > 20d MA", v, "%", +1, `${v.toFixed(0)}% < 20 broad selloff`);
    if (v > 90)  return c("NDX > 20d MA", v, "%", -2, `${v.toFixed(0)}% > 90 extreme breadth thrust`);
    if (v > 80)  return c("NDX > 20d MA", v, "%", -1, `${v.toFixed(0)}% > 80 stretched breadth`);
    return c("NDX > 20d MA", v, "%", 0, "Breadth in normal range");
  }

  if (id === "sp500_pe_ratio") {
    if (v <= 22) return c("S&P 500 PE", v, "x", +2, `PE ${v.toFixed(1)}x ≤ 22 deep value`);
    if (v <= 25) return c("S&P 500 PE", v, "x", +1, `PE ${v.toFixed(1)}x ≤ 25 cheap valuation`);
    if (v >= 35) return c("S&P 500 PE", v, "x", -2, `PE ${v.toFixed(1)}x ≥ 35 extreme valuation`);
    if (v >= 31) return c("S&P 500 PE", v, "x", -1, `PE ${v.toFixed(1)}x ≥ 31 expensive`);
    return c("S&P 500 PE", v, "x", 0, "PE in normal range");
  }

  if (id === "nasdaq100_pe_ratio") {
    if (v <= 22) return c("NDX 100 PE", v, "x", +2, `NDX PE ${v.toFixed(1)}x ≤ 22 deep value`);
    if (v <= 26) return c("NDX 100 PE", v, "x", +1, `NDX PE ${v.toFixed(1)}x ≤ 26 cheap`);
    if (v >= 34) return c("NDX 100 PE", v, "x", -2, `NDX PE ${v.toFixed(1)}x ≥ 34 extreme valuation`);
    if (v >= 30) return c("NDX 100 PE", v, "x", -1, `NDX PE ${v.toFixed(1)}x ≥ 30 expensive`);
    return c("NDX 100 PE", v, "x", 0, "NDX PE in normal range");
  }

  if (id === "cboe_skew") {
    if (v >= 160) return c("CBOE SKEW", v, "", -2, `SKEW ${v.toFixed(1)} ≥ 160 extreme tail-hedging`);
    if (v >= 155) return c("CBOE SKEW", v, "", -1, `SKEW ${v.toFixed(1)} ≥ 155 tail-hedging spike`);
    if (v <= 130) return c("CBOE SKEW", v, "", +2, `SKEW ${v.toFixed(1)} ≤ 130 extreme complacency`);
    if (v <= 135) return c("CBOE SKEW", v, "", +1, `SKEW ${v.toFixed(1)} ≤ 135 low tail-hedging`);
    return c("CBOE SKEW", v, "", 0, "SKEW in normal range");
  }

  if (id === "yc_10y_2y") {
    if (recentlyInverted && v >= -0.05 && v <= 0.6) {
      return c("10Y-2Y Curve", v, "%", -1, `${v >= 0 ? "+" : ""}${v.toFixed(2)}% in re-steepening top window after recent inversion`);
    }
    return c("10Y-2Y Curve", v, "%", 0, "Curve in normal range");
  }

  return null;
}

function classify(score: number): [string, string] {
  for (const [threshold, label, css] of BANDS) {
    if (score >= threshold) return [label, css];
  }
  return ["Strong Risk", "regime-strong-risk"];
}

export function computeMarketRegime(
  latest: Record<string, Observation>,
  ycRecentlyInverted = true,
  now: Date = new Date(),
): MarketRegime {
  const contributions: RegimeContribution[] = [];
  const stale: MarketRegime["stale"] = [];
  let considered = 0;

  // Only the scored indicators count: D1 also holds retired series, which
  // used to inflate the total ("4 of 17").
  for (const id of ALL_INDICATOR_IDS) {
    const o = latest[id];
    if (!o) continue;
    const c = scoreOne(o, ycRecentlyInverted);
    if (!c) continue;
    if (isStale(o, now)) {
      // Listed at 0 points so the page shows the source has gone quiet.
      stale.push({ indicator_id: id, as_of: o.as_of });
      contributions.push({ ...c, tier: 0, points: 0, reason: `No reading since ${o.as_of}, not scored`, stale: true });
      continue;
    }
    considered++;
    contributions.push(c);
  }

  const buy = Math.round(contributions.filter((c) => c.points > 0).reduce((s, c) => s + c.points, 0) * 100) / 100;
  const risk = Math.round(contributions.filter((c) => c.points < 0).reduce((s, c) => s - c.points, 0) * 100) / 100;
  const score = Math.round((buy - risk) * 100) / 100;
  const [label, css_class] = classify(score);

  const fired = contributions.filter((c) => c.tier !== 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  let summary = "All indicators in normal ranges.";
  if (fired.length) {
    const pos = fired.filter((c) => c.points > 0);
    const neg = fired.filter((c) => c.points < 0);
    const parts: string[] = [];
    if (pos.length) parts.push("Bottom signals: " + pos.map((c) => `${c.title} (${c.points >= 0 ? "+" : ""}${c.points.toFixed(1)})`).join(", "));
    if (neg.length) parts.push("Top signals: " + neg.map((c) => `${c.title} (${c.points >= 0 ? "+" : ""}${c.points.toFixed(1)})`).join(", "));
    summary = parts.join(" · ");
  }

  const order = Object.fromEntries(ALL_INDICATOR_IDS.map((id, i) => [id, i]));
  const sorted = [...contributions].sort((a, b) => (order[a.indicator_id] ?? 999) - (order[b.indicator_id] ?? 999));

  return {
    score,
    buy_points: buy,
    risk_points: risk,
    label,
    css_class,
    summary,
    contributions: sorted,
    coverage: contributions.filter((c) => c.tier !== 0).length,
    total: considered,
    stale,
    yc_recently_inverted: ycRecentlyInverted,
  };
}

// ── Regime v2 (shadow mode) ─────────────────────────────────────────────────
// Backtested in research/backtest/regime_v2.py; the design and the numbers
// are in docs/algorithm-v2-plan.md, section 2.7. v1 stays the published
// score (and drives push alerts) until v2 has run beside it for a few weeks.

type Series = ReadonlyArray<{ as_of: string; value: number; unit?: string }>;

// Greed-level risk tiers v2 drops: in the 1990–2026 test low VIX, high RSI,
// strong breadth and tight HY spreads came *before* calmer markets, not tops.
// SKEW's risk side moves to the stress rule below (≥150 / ≥160).
const V2_DROPPED_RISK = new Set(["vix", "sp500_rsi", "nasdaq100_above_20d_ma", "us_high_yield_spread", "cboe_skew"]);

const STRESS_WEIGHTS: Record<StressInput["id"], number> = {
  rates: 1.0, move: 1.0, hy_widening: 1.5, nfci: 1.0, skew: 0.8, narrow: 1.0,
};
const BOTTOM_GUARD = 4.5;   // buy points at which stress counts half
const r2 = (x: number) => Math.round(x * 100) / 100;
const tier2 = (x: number, a: number, b: number) => (x >= b ? 2 : x >= a ? 1 : 0);
const signed = (x: number, digits = 2) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(digits);

function fresh(series: Series | undefined, id: string, now: Date): Series | null {
  if (!series?.length) return null;
  const last = series[series.length - 1];
  return ageDays(last.as_of, now) > (MAX_AGE_DAYS[id] ?? 7) ? null : series;
}

/** Change over the last `back` rows (trading days for daily series). */
function rowChange(series: Series, back: number): number | null {
  const n = series.length;
  return n > back ? series[n - 1].value - series[n - 1 - back].value : null;
}

function stressInput(
  id: StressInput["id"], title: string, fields: Partial<StressInput>,
): StressInput {
  return {
    id, title, value: null, unit: "", detail: "", as_of: null, tier: 0,
    weight: STRESS_WEIGHTS[id], points: 0, reason: "", counts: id !== "narrow",
    ...fields,
  };
}

function quiet(id: StressInput["id"], title: string, series: Series | undefined, need: string): StressInput {
  const last = series?.length ? series[series.length - 1] : null;
  return last
    ? stressInput(id, title, { as_of: last.as_of, stale: true, reason: `No reading since ${last.as_of}, not scored` })
    : stressInput(id, title, { missing: true, reason: `Waiting for ${need}` });
}

function rateShock(h: Record<string, Series>, now: Date): StressInput {
  const title = "Rate shock";
  const real = fresh(h.real_yield_10y, "real_yield_10y", now);
  const nom = fresh(h.ust_10y, "ust_10y", now);
  const dReal = real ? rowChange(real, 20) : null;
  const dNom = nom ? rowChange(nom, 20) : null;
  if (dReal == null && dNom == null) return quiet("rates", title, h.real_yield_10y ?? h.ust_10y, "20 days of 10-year yields");
  const tReal = dReal == null ? 0 : tier2(dReal, 0.25, 0.40);
  const tNom = dNom == null ? 0 : tier2(dNom, 0.40, 0.60);
  const tier = Math.max(tReal, tNom);
  const parts = [dReal == null ? null : `real ${signed(dReal)}`, dNom == null ? null : `10Y ${signed(dNom)}`].filter(Boolean);
  const detail = `${parts.join(" / ")} pp in 20 days`;
  const asOf = [real, nom].filter(Boolean).map((x) => x![x!.length - 1].as_of).sort().pop() ?? null;
  let reason = "Yields steady";
  if (tier) {
    reason = tReal >= tNom
      ? `Real yield ${signed(dReal!)} pp in 20 days ≥ ${tReal === 2 ? "+0.40" : "+0.25"}`
      : `10Y yield ${signed(dNom!)} pp in 20 days ≥ ${tNom === 2 ? "+0.60" : "+0.40"}`;
  }
  return stressInput("rates", title, { value: r2(Math.max(dReal ?? -9, dNom ?? -9)), unit: "pp", detail, as_of: asOf, tier, reason });
}

function moveStress(h: Record<string, Series>, now: Date): StressInput {
  const title = "MOVE";
  const s = fresh(h.move_index, "move_index", now);
  if (!s) return quiet("move", title, h.move_index, "the MOVE index");
  const v = s[s.length - 1].value;
  const tier = tier2(v, 110, 130);
  const reason = tier === 2 ? `MOVE ${v.toFixed(0)} ≥ 130 bond-market stress` : tier ? `MOVE ${v.toFixed(0)} ≥ 110 elevated` : `MOVE ${v.toFixed(0)} calm`;
  return stressInput("move", title, { value: r2(v), detail: `${v.toFixed(1)}`, as_of: s[s.length - 1].as_of, tier, reason });
}

function hyWidening(h: Record<string, Series>, now: Date): StressInput {
  const title = "HY widening";
  const s0 = fresh(h.us_high_yield_spread, "us_high_yield_spread", now);
  if (!s0 || s0.length < 21) return quiet("hy_widening", title, h.us_high_yield_spread, "20 days of HY spreads");
  // D1 stores bp; very old rows may be in percent.
  const s = s0.map((r) => ({ as_of: r.as_of, value: r.value > 30 || r.unit === "bp" ? r.value : r.value * 100 }));
  const d20 = rowChange(s, 20)!;
  const low60 = Math.min(...s.slice(-60).map((r) => r.value));
  const above = s[s.length - 1].value - low60;
  const tD = tier2(d20, 40, 75);
  const tL = tier2(above, 60, 100);
  const tier = Math.max(tD, tL);
  let reason = "Credit spreads steady";
  if (tier) {
    reason = tD >= tL
      ? `HY ${signed(d20, 0)} bp in 20 days ≥ ${tD === 2 ? "+75" : "+40"}`
      : `HY ${signed(above, 0)} bp above its 60-day low ≥ ${tL === 2 ? "+100" : "+60"}`;
  }
  return stressInput("hy_widening", title, {
    value: r2(d20), unit: "bp", as_of: s[s.length - 1].as_of, tier, reason,
    detail: `${signed(d20, 0)} bp in 20 days · ${signed(above, 0)} bp above 60-day low`,
  });
}

function nfciStress(h: Record<string, Series>, now: Date): StressInput {
  const title = "NFCI";
  const s = fresh(h.nfci, "nfci", now);
  if (!s || s.length < 5) return quiet("nfci", title, h.nfci, "5 weeks of NFCI");
  const d4 = rowChange(s, 4)!;
  const v = s[s.length - 1].value;
  const tier = tier2(d4, 0.05, 0.10);
  const reason = tier ? `NFCI ${signed(d4)} in 4 weeks ≥ ${tier === 2 ? "+0.10" : "+0.05"}: financial conditions tightening` : "Financial conditions steady";
  return stressInput("nfci", title, { value: r2(d4), detail: `${v.toFixed(2)} (4-week change ${signed(d4)})`, as_of: s[s.length - 1].as_of, tier, reason });
}

function skewStress(h: Record<string, Series>, now: Date): StressInput {
  const title = "SKEW";
  const s = fresh(h.cboe_skew, "cboe_skew", now);
  if (!s) return quiet("skew", title, h.cboe_skew, "CBOE SKEW");
  const v = s[s.length - 1].value;
  const tier = tier2(v, 150, 160);
  const reason = tier === 2 ? `SKEW ${v.toFixed(1)} ≥ 160 heavy tail hedging` : tier ? `SKEW ${v.toFixed(1)} ≥ 150 tail hedging` : `SKEW ${v.toFixed(1)} normal`;
  return stressInput("skew", title, { value: r2(v), detail: v.toFixed(1), as_of: s[s.length - 1].as_of, tier, reason });
}

function narrowMarket(h: Record<string, Series>, now: Date): StressInput {
  const title = "Narrow market";
  const off = fresh(h.sp500_off_high, "sp500_off_high", now);
  const br = fresh(h.sp500_above_50d_ma, "sp500_above_50d_ma", now);
  if (!off || !br) return quiet("narrow", title, (off ? h.sp500_above_50d_ma : h.sp500_off_high), off ? "S&P 500 member breadth" : "the S&P 500 high");
  const o = off[off.length - 1].value;
  const b = br[br.length - 1].value;
  const tier = o >= -2 && b < 55 ? 1 : 0;
  const reason = tier
    ? `S&P within 2% of its high, only ${b.toFixed(0)}% of members above the 50-day MA`
    : o >= -2 ? `S&P near its high with ${b.toFixed(0)}% of members above the 50-day MA` : `S&P ${Math.abs(o).toFixed(1)}% below its high`;
  return stressInput("narrow", title, {
    value: r2(b), unit: "%", as_of: br[br.length - 1].as_of, tier, reason,
    detail: `${Math.abs(o).toFixed(1)}% below high · ${b.toFixed(0)}% above 50-day MA`,
  });
}

export function computeMarketRegimeV2(
  latest: Record<string, Observation>,
  history: Record<string, Series>,
  ycRecentlyInverted = true,
  now: Date = new Date(),
): MarketRegimeV2 {
  const contributions: RegimeContribution[] = [];
  for (const id of ALL_INDICATOR_IDS) {
    const o = latest[id];
    if (!o) continue;
    const c = scoreOne(o, ycRecentlyInverted);
    if (!c) continue;
    if (isStale(o, now)) {
      contributions.push({ ...c, tier: 0, points: 0, reason: `No reading since ${o.as_of}, not scored`, stale: true });
    } else if (c.tier < 0 && V2_DROPPED_RISK.has(id)) {
      contributions.push({ ...c, tier: 0, points: 0, reason: `${c.reason}; not scored in v2` });
    } else {
      contributions.push(c);
    }
  }
  const buy = r2(contributions.filter((c) => c.points > 0).reduce((t, c) => t + c.points, 0));
  const levelRisk = r2(contributions.filter((c) => c.points < 0).reduce((t, c) => t - c.points, 0));

  const stress = [rateShock, moveStress, hyWidening, nfciStress, skewStress, narrowMarket].map((f) => f(history, now));
  const halved = buy >= BOTTOM_GUARD;
  let raw = 0;
  for (const x of stress) {
    raw += x.tier * x.weight;
    x.points = x.tier ? -r2(x.tier * x.weight * (halved ? 0.5 : 1)) : 0;
  }
  const stressPts = r2(stress.reduce((t, x) => t - x.points, 0));
  const score = r2(buy - levelRisk - stressPts);
  const [label, css_class] = classify(score);

  const fmt = (t: string, p: number) => `${t} (${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)})`;
  const parts: string[] = [];
  const firing = stress.filter((x) => x.points < 0).sort((a, b) => a.points - b.points);
  if (firing.length) parts.push("Stress: " + firing.map((x) => fmt(x.title, x.points)).join(", ") + (halved ? " (halved)" : ""));
  const pos = contributions.filter((c) => c.points > 0).sort((a, b) => b.points - a.points);
  if (pos.length) parts.push("Bottom signals: " + pos.map((c) => fmt(c.title, c.points)).join(", "));
  const neg = contributions.filter((c) => c.points < 0).sort((a, b) => a.points - b.points);
  if (neg.length) parts.push("Top signals: " + neg.map((c) => fmt(c.title, c.points)).join(", "));

  return {
    version: 2,
    score, label, css_class,
    buy_points: buy,
    risk_points: levelRisk,
    stress_points: stressPts,
    stress_raw: r2(raw),
    stress_halved: halved,
    stress_count: stress.filter((x) => x.counts && x.tier > 0).length,
    summary: parts.join(" · ") || "No stress and no indicator in a signal zone.",
    contributions,
    stress,
    computed_at: now.toISOString(),
  };
}
