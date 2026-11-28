export interface Env {
  DB: D1Database;
  FINNHUB_KEY?: string;
  FRED_API_KEY?: string;
  ENVIRONMENT?: string;
  // Supabase (Google sign-in). URL + anon key are public; ADMIN_EMAILS is a
  // secret listing who may edit the shared watchlist.
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ADMIN_EMAILS?: string;
  // Push alerts. SUPABASE_SECRET_KEY and VAPID_PRIVATE_KEY are secrets; the
  // rest are plain vars in wrangler.toml. PUSH_ENABLED="true" turns sending on.
  SUPABASE_SECRET_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  PUSH_ENABLED?: string;
}

export interface Observation {
  indicator_id: string;
  as_of: string;
  value: number;
  unit: string;
  source: string;
  meta_json?: string | null;
  inserted_at: string;
}

export interface Signal {
  indicator_id: string;
  top: boolean;
  bottom: boolean;
  title: string;
  detail: string;
  meta?: Record<string, unknown> | null;
  stale?: boolean;   // reading too old to use (see lib/freshness.ts)
}

export interface RegimeContribution {
  indicator_id: string;
  title: string;
  value: number;
  unit: string;
  tier: number;
  weight: number;
  points: number;
  reason: string;
  stale?: boolean;   // listed for display only, scored 0
}

// ── Market regime (v2, live since 2026-11-28) ───────────────────────────────
// The buy side scores how extreme fear, valuation and credit levels are; the
// risk side scores stress building (docs/algorithm-v2-plan.md, section 2.7)
// plus the level-based tops that held up (sentiment greed, valuation, the
// yield-curve window). Greed-level "tops" (low VIX, high RSI, strong breadth,
// tight spreads) were dropped: they came before calmer markets, not tops.
export interface StressInput {
  id: "rates" | "move" | "hy_widening" | "nfci" | "skew" | "narrow";
  title: string;
  value: number | null;        // the reading the rule looks at
  unit: string;
  detail: string;              // e.g. "real +0.48 / 10Y +0.50 pp in 20 days"
  as_of: string | null;
  tier: number;                // 0, 1 or 2
  weight: number;
  points: number;              // ≤ 0, after the bottom-guard halving
  reason: string;
  counts: boolean;             // part of the stress count (all but "narrow")
  stale?: boolean;             // reading too old, not scored
  missing?: boolean;           // not enough history yet
}

export interface MarketRegime {
  version: 2;
  score: number;
  label: string;
  css_class: string;
  summary: string;
  buy_points: number;
  risk_points: number;         // level risk + stress (the whole risk side)
  level_risk_points: number;   // sentiment greed, valuation, yield-curve window
  stress_points: number;       // after halving
  stress_raw: number;
  stress_halved: boolean;      // buy points ≥ 4.5: stress counts half
  stress_count: number;        // stress inputs firing (rates, MOVE, HY, NFCI, SKEW)
  contributions: RegimeContribution[];   // indicators, then stress inputs
  stress: StressInput[];
  coverage: number;            // contributions adding points
  total: number;               // fresh indicators and stress inputs
  stale: Array<{ indicator_id: string; as_of: string }>;  // left out of the score
  yc_recently_inverted: boolean;
  computed_at: string;
}

export const STRESS_SERIES_IDS = [
  "real_yield_10y", "ust_10y", "us_high_yield_spread", "nfci",
  "move_index", "cboe_skew", "sp500_above_50d_ma", "sp500_off_high",
] as const;

export const ALL_INDICATOR_IDS = [
  "cnn_fear_greed_index",
  "cnn_put_call_options",
  "vix",
  "sp500_rsi",
  "sp500_pe_ratio",
  "nasdaq100_pe_ratio",
  "nasdaq100_above_20d_ma",
  "us_high_yield_spread",
  "cboe_skew",
  "yc_10y_2y",
] as const;

export type IndicatorId = (typeof ALL_INDICATOR_IDS)[number];
