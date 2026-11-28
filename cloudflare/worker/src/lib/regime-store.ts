import type { Env, MarketRegime } from "./types";
import { STRESS_SERIES_IDS } from "./types";
import { getLatestObservations, getRecentObservations, getSeriesSince } from "./db";
import { computeMarketRegime } from "./regime";

// ── The regime snapshot ──────────────────────────────────────────────────────
// Scoring the regime reads ~1,200 D1 rows (latest readings, 130 days of the
// stress series, two years of the yield curve), so it isn't done per page
// view. Every run that stores new readings (both crons, the Update button)
// recomputes it and keeps the result in kv_store; /api/regime, the signal
// table, push alerts and the watchlist read that one row.
const SNAPSHOT_KEY = "regime:current";

// The score is also kept as a daily series ("market_regime" in observations,
// one row per market date, rewritten until the next session starts), so the
// Key Indicators chart can show its history. Rows before 2026-11-28 were
// backfilled by replaying this same scoring on the stored inputs.
export const REGIME_SERIES_ID = "market_regime";

async function scoreNow(env: Env): Promise<{ regime: MarketRegime; marketDate: string | null }> {
  const [latest, history, ycHistory] = await Promise.all([
    getLatestObservations(env.DB),
    getSeriesSince(env.DB, STRESS_SERIES_IDS, 130),
    getRecentObservations(env.DB, "yc_10y_2y", 720),
  ]);
  const regime = computeMarketRegime(latest, history, ycHistory.some((o) => o.value < 0));
  // The market date: the newest daily close the Yahoo indices brought in.
  const marketDate = [latest.vix?.as_of, latest.cboe_skew?.as_of].filter(Boolean).sort().pop() ?? null;
  return { regime, marketDate };
}

export async function computeRegimeNow(env: Env): Promise<MarketRegime> {
  return (await scoreNow(env)).regime;
}

export async function refreshRegimeSnapshot(env: Env): Promise<MarketRegime> {
  const { regime, marketDate } = await scoreNow(env);
  const stmts = [
    env.DB.prepare(
      "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(SNAPSHOT_KEY, JSON.stringify(regime)),
  ];
  if (marketDate) {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    stmts.push(env.DB.prepare(
      `INSERT INTO observations (indicator_id, as_of, value, unit, source, meta_json, inserted_at)
       VALUES (?, ?, ?, 'index', 'kiwiboard', ?, ?)
       ON CONFLICT(indicator_id, as_of) DO UPDATE SET value = excluded.value, meta_json = excluded.meta_json,
         inserted_at = excluded.inserted_at`,
    ).bind(REGIME_SERIES_ID, marketDate, regime.score, JSON.stringify({ label: regime.label }), now));
  }
  await env.DB.batch(stmts);
  return regime;
}

export async function readRegimeSnapshot(env: Env): Promise<MarketRegime | null> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?")
    .bind(SNAPSHOT_KEY).first<{ value: string }>();
  try {
    const r = row ? JSON.parse(row.value) as MarketRegime : null;
    return r && r.version === 2 ? r : null;
  } catch {
    return null;
  }
}

/** The stored snapshot, or (first call after a deploy) a fresh one. */
export async function getRegime(env: Env): Promise<MarketRegime> {
  return (await readRegimeSnapshot(env).catch(() => null)) ?? refreshRegimeSnapshot(env);
}
