import type { Observation } from "./types";

// How many calendar days a reading stays usable. Older readings still show on
// the page, marked stale, but no longer move the score or fire a signal.
// Before this guard the regime kept scoring whatever row was newest, so a
// source that broke (Barchart in September 2026, YCharts in August) went
// unnoticed for months. Daily series allow a long weekend plus a holiday and
// a late publisher; the AAII survey is weekly.
export const MAX_AGE_DAYS: Record<string, number> = {
  vix: 6,
  cnn_fear_greed_index: 6,
  cnn_put_call_options: 6,
  sp500_rsi: 6,
  cboe_skew: 6,
  nasdaq100_above_20d_ma: 6,
  us_high_yield_spread: 7,   // FRED posts a day late
  yc_10y_2y: 7,
  sp500_pe_ratio: 10,
  nasdaq100_pe_ratio: 10,
  bofa_bull_bear: 14,        // weekly survey
};
const DEFAULT_MAX_AGE_DAYS = 7;

/** Whole calendar days from `asOf` (YYYY-MM-DD) to today (UTC). */
export function ageDays(asOf: string, now: Date = new Date()): number {
  const t = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return Infinity;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - t) / 86_400_000);
}

export function isStale(o: Observation, now: Date = new Date()): boolean {
  return ageDays(o.as_of, now) > (MAX_AGE_DAYS[o.indicator_id] ?? DEFAULT_MAX_AGE_DAYS);
}
