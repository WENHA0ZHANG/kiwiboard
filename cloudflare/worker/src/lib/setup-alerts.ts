import type { Env } from "./types";
import type { YahooBar } from "./yahoo";
import type { WatchMetrics } from "./analysis";
import type { SignalRow } from "./signal-log";
import { deliver, pushConfigured, type AlertTarget } from "./alerts";
import { sbRpc } from "./supabase";

// ── Buy-point push alerts ───────────────────────────────────────────────────
// While the US session trades, every */30 refresh of the shared watchlist
// looks at each refreshed symbol's still-forming daily bar for:
//   • a logged buy-stop (tight pullback, 21 EMA pullback, base breakout)
//     whose trigger today's high has crossed, inside its valid sessions;
//   • an EP gap forming today (the tested trade buys it near the close).
// Each one goes out once, to users who turned "Buy points" on in Settings
// (notification_prefs.setup_alerts → setup_alert_targets() in Supabase).
// The signal log still grades the trade from finished bars after the close.

const SENT_KEY = "setup_alerts:sent";
const KEEP_MS = 10 * 86400 * 1000;
// Each alert costs one request per device plus two to Supabase; the cron run
// has 50 in all, so a busy day spreads over the next runs.
const MAX_PER_RUN = 3;

export interface BuyPointAlert {
  key: string;
  symbol: string;
  title: string;
  body: string;
}

const px = (v: number) => v.toFixed(2);

/** Buy points on today's forming bar, from the pending signals and the setups. */
export function findBuyPoints(
  scored: Array<{ metrics: WatchMetrics; bars: YahooBar[]; complete: boolean }>,
  active: SignalRow[],
): BuyPointAlert[] {
  const out: BuyPointAlert[] = [];
  for (const x of scored) {
    if (x.complete) continue;                       // only while the session trades
    const bars = x.bars;
    const n = bars.length;
    if (n < 2) continue;
    const today = bars[n - 1];
    const sym = x.metrics.symbol;

    for (const sig of active) {
      if (sig.symbol !== sym || sig.status !== "pending" || sig.entry_type !== "stop") continue;
      const t = bars.findIndex((b) => b.date === sig.signal_date);
      const k = n - 1 - t;                          // sessions since the signal bar
      if (t < 0 || k < 1 || k > sig.window) continue;
      // Same fill rule as gradeSignal: bases fill at the pivot, setups above the high.
      const hit = sig.setup === "BASE" ? today.high >= sig.trigger : today.high > sig.trigger;
      if (!hit) continue;
      out.push({
        key: `sig:${sig.id}`,
        symbol: sym,
        title: `${sym}: buy point hit`,
        body: `${sig.label} above ${px(sig.trigger)} · stop ${px(sig.stop)}`,
      });
    }

    for (const s of x.metrics.setups ?? []) {
      if (s.code !== "EP" || s.state !== "forming") continue;
      const gap = (today.open / bars[n - 2].close - 1) * 100;
      out.push({
        key: `ep:${sym}:${s.signal_date}`,
        symbol: sym,
        title: `${sym}: EP gap +${gap.toFixed(0)}%`,
        body: `Buy near the close if it holds · stop ${px(s.stop)}`,
      });
    }
  }
  return out;
}

async function loadSent(env: Env): Promise<Record<string, number>> {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(SENT_KEY).first<{ value: string }>();
  try { return row ? JSON.parse(row.value) as Record<string, number> : {}; } catch { return {}; }
}

async function saveSent(env: Env, sent: Record<string, number>): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).bind(SENT_KEY, JSON.stringify(sent)).run();
}

/** Push the buy points not sent yet. Returns a log line. */
export async function pushBuyPoints(env: Env, alerts: BuyPointAlert[]): Promise<string> {
  if (!alerts.length) return "none";
  const sent = await loadSent(env);
  const due = alerts.filter((a, i) => !sent[a.key] && alerts.findIndex((b) => b.key === a.key) === i);
  if (!due.length) return `${alerts.length} already sent`;
  if (env.PUSH_ENABLED !== "true" || !pushConfigured(env)) return `${due.length} found, push disabled`;

  let targets: AlertTarget[];
  try {
    targets = await sbRpc<AlertTarget[]>(env, "setup_alert_targets", {});
  } catch (e) {
    // Most likely the Supabase function isn't there yet; try again next run.
    return `${due.length} found, no recipients (${String(e).slice(0, 120)})`;
  }

  const batch = due.slice(0, MAX_PER_RUN);
  const now = Date.now();
  // Mark first so a failure mid-send can't cause a duplicate next run.
  for (const a of batch) sent[a.key] = now;
  for (const k of Object.keys(sent)) if (now - sent[k] > KEEP_MS) delete sent[k];
  await saveSent(env, sent);

  const parts: string[] = [];
  for (const a of batch) {
    if (!targets.length) { parts.push(`${a.key} 0 devices`); continue; }
    const r = await deliver(env, targets, { title: a.title, body: a.body, url: "/#watchlist", tag: `setup-${a.symbol}` }, "setup");
    parts.push(`${a.key} ${r.delivered}/${targets.length}`);
  }
  if (due.length > batch.length) parts.push(`${due.length - batch.length} left for the next run`);
  return parts.join(", ");
}
