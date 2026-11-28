import type { YahooBar } from "./yahoo";

// ── New York session clock ───────────────────────────────────────────────────
// Shared by the Worker and the daily market scan (cloudflare/scan), so both
// decide the same way whether the newest daily bar is final.

/** New York date, weekday and minutes since midnight. */
export function nyClock(now = new Date()): { date: string; weekday: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * False while the newest daily bar is today's New York session and may still
 * change: until 16:15, so the 16:00 run doesn't log a setup from a close the
 * auction hasn't settled yet.
 */
export function lastBarComplete(bars: YahooBar[], now = new Date()): boolean {
  const last = bars[bars.length - 1];
  if (!last) return true;
  const ny = nyClock(now);
  return last.date !== ny.date || ny.minutes >= 16 * 60 + 15;
}
