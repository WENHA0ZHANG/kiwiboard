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

export interface MarketRegime {
  score: number;
  buy_points: number;
  risk_points: number;
  label: string;
  css_class: string;
  summary: string;
  contributions: RegimeContribution[];
  coverage: number;
  total: number;                                          // indicators with fresh data
  stale: Array<{ indicator_id: string; as_of: string }>;  // left out of the score
  yc_recently_inverted: boolean;
}

export const ALL_INDICATOR_IDS = [
  "cnn_fear_greed_index",
  "cnn_put_call_options",
  "vix",
  "bofa_bull_bear",
  "sp500_rsi",
  "sp500_pe_ratio",
  "nasdaq100_pe_ratio",
  "nasdaq100_above_20d_ma",
  "us_high_yield_spread",
  "cboe_skew",
  "yc_10y_2y",
] as const;

export type IndicatorId = (typeof ALL_INDICATOR_IDS)[number];
