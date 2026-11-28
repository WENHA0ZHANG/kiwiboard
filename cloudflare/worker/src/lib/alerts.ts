import type { Env, MarketRegime } from "./types";
import { getRegime } from "./regime-store";
import { isKnownPushService, sendPush, type PushTarget, type VapidKeys } from "./webpush";
import { sbDeleteSubscription, sbInsert, sbRpc, supabaseAdminConfigured } from "./supabase";

// ── Poor2Rich regime-change push alerts ─────────────────────────────────────
// Each cron tick computes the regime. A new band only counts once it shows up
// on CONFIRM_TICKS consecutive ticks (so a score hovering around a threshold
// doesn't spam), and the same band isn't announced twice within the cooldown.
// Who gets it is decided in Supabase (regime_alert_targets: each user's
// chosen bands; default Strong Buy / Buy / Cautious Buy / Risk / Strong Risk).

const CONFIRM_TICKS = 2;
const SAME_BAND_COOLDOWN_MS = 12 * 3600 * 1000;
const STATE_KEY = "regime_alert_state";

interface AlertState {
  stable: string | null;        // last confirmed band
  candidate: string | null;     // band seen on recent ticks but not confirmed yet
  candidateTicks: number;
  lastSent: { label: string; at: number } | null;
  model?: number;               // regime version the stable band came from
}

// Bands confirmed under an older regime model don't count: the switch to v2
// on 2026-11-28 changed the score's method, not the market, so its first
// reading becomes the new baseline instead of a "Regime changed" push.
const MODEL = 2;

export interface AlertTarget extends PushTarget {
  user_id: string;
}

export function pushConfigured(env: Env): boolean {
  return Boolean(supabaseAdminConfigured(env) && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function vapidKeys(env: Env): VapidKeys {
  return {
    publicKey: env.VAPID_PUBLIC_KEY || "",
    privateKey: env.VAPID_PRIVATE_KEY || "",
    subject: env.VAPID_SUBJECT || "https://poortrader.com",
  };
}

// Same snapshot as GET /api/regime.
export async function currentRegime(env: Env): Promise<MarketRegime> {
  return getRegime(env);
}

// Bands from most bearish to most bullish (for "Up / Down from …").
const BAND_ORDER = ["Strong Risk", "Risk", "Caution", "Neutral", "Cautious Buy", "Buy", "Strong Buy"];

// Kept short on purpose: a lock-screen notification shows a line or two.
// No emoji; the notification already carries the app icon.
//   title "Regime: Buy (+4.7)"   body "Up from Cautious Buy"
export function regimeMessage(regime: MarketRegime, from: string | null) {
  const score = (regime.score >= 0 ? "+" : "") + regime.score.toFixed(1);
  let body = "";
  if (from && from !== regime.label) {
    const a = BAND_ORDER.indexOf(from);
    const b = BAND_ORDER.indexOf(regime.label);
    body = a >= 0 && b >= 0 ? `${b > a ? "Up" : "Down"} from ${from}` : `Was ${from}`;
  }
  return {
    title: `Regime: ${regime.label} (${score})`,
    body,
    url: "/#prediction",
    tag: "regime",
  };
}

// Send one message to many devices; prune dead subscriptions; log per user.
export async function deliver(
  env: Env,
  targets: AlertTarget[],
  message: { title: string; body: string; url: string; tag: string },
  kind: string,
): Promise<{ delivered: number; failed: number; removed: number }> {
  const vapid = vapidKeys(env);
  const usersReached = new Set<string>();
  const gone: string[] = [];
  let delivered = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += 10) {
    const batch = targets.slice(i, i + 10);
    const results = await Promise.allSettled(batch.map((t) =>
      isKnownPushService(t.endpoint)
        ? sendPush(t, message, vapid, { topic: kind, urgency: "high", ttl: 24 * 3600 })
        : Promise.resolve(400),
    ));
    results.forEach((r, j) => {
      const status = r.status === "fulfilled" ? r.value : 0;
      if (status >= 200 && status < 300) { delivered++; usersReached.add(batch[j].user_id); }
      else if (status === 404 || status === 410) gone.push(batch[j].endpoint);
      else { failed++; console.warn(`push to ${new URL(batch[j].endpoint).host} failed:`, r.status === "fulfilled" ? status : r.reason); }
    });
  }
  await Promise.allSettled([
    ...gone.map((ep) => sbDeleteSubscription(env, ep)),
    sbInsert(env, "notification_log", [...usersReached].map((user_id) => ({
      user_id, kind, title: message.title, body: message.body, url: message.url,
    }))),
  ]);
  return { delivered, failed, removed: gone.length };
}

async function loadState(env: Env): Promise<AlertState> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(STATE_KEY).first<{ value: string }>();
  try { if (row) return JSON.parse(row.value) as AlertState; } catch { /* reset below */ }
  return { stable: null, candidate: null, candidateTicks: 0, lastSent: null };
}

async function saveState(env: Env, st: AlertState): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(STATE_KEY, JSON.stringify(st)).run();
}

// Called from the cron after fresh indicators are stored (and the snapshot
// recomputed, which it passes in). Returns a log line.
export async function checkRegimeAlert(env: Env, fresh?: MarketRegime): Promise<string> {
  const regime = fresh ?? await currentRegime(env);
  const label = regime.label;
  const st = await loadState(env);
  const head = `regime ${label} ${regime.score.toFixed(2)}`;

  if (st.stable === null || st.model !== MODEL) { // first run or new model: remember, don't alert
    const was = st.stable;
    st.stable = label;
    st.candidate = null;
    st.candidateTicks = 0;
    st.model = MODEL;
    await saveState(env, st);
    return `${head} (baseline saved${was ? `; was ${was} under the old model` : ""})`;
  }
  if (label === st.stable) {
    if (st.candidate) { st.candidate = null; st.candidateTicks = 0; await saveState(env, st); }
    return `${head} (unchanged)`;
  }

  st.candidateTicks = st.candidate === label ? st.candidateTicks + 1 : 1;
  st.candidate = label;
  if (st.candidateTicks < CONFIRM_TICKS) {
    await saveState(env, st);
    return `${head} (new band, waiting ${st.candidateTicks}/${CONFIRM_TICKS})`;
  }

  // Confirmed change.
  const from = st.stable;
  st.stable = label;
  st.candidate = null;
  st.candidateTicks = 0;
  const now = Date.now();
  const coolingDown = st.lastSent?.label === label && now - st.lastSent.at < SAME_BAND_COOLDOWN_MS;
  let outcome = "";
  if (env.PUSH_ENABLED !== "true" || !pushConfigured(env)) {
    outcome = "push disabled/not configured";
  } else if (coolingDown) {
    outcome = "same band announced <12h ago, skipped";
  } else {
    // Persist first so a failure mid-send can't cause a duplicate next tick.
    st.lastSent = { label, at: now };
    await saveState(env, st);
    const targets = await sbRpc<AlertTarget[]>(env, "regime_alert_targets", { p_label: label });
    const r = await deliver(env, targets, regimeMessage(regime, from), "regime");
    return `${head} (changed from ${from}: pushed ${r.delivered}/${targets.length}, removed ${r.removed})`;
  }
  await saveState(env, st);
  return `${head} (changed from ${from}: ${outcome})`;
}
