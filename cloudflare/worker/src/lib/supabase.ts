import type { Env } from "./types";

// Server-side Supabase access with the project's secret key (bypasses RLS).
// Only used for push: finding who to alert, pruning dead devices, logging.
// New-style keys (sb_secret_…) go in `apikey` only; a legacy service_role JWT
// also has to be sent as the bearer token.

export function supabaseAdminConfigured(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

function base(env: Env): string {
  return (env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  const key = env.SUPABASE_SECRET_KEY || "";
  const h: Record<string, string> = { apikey: key, "Content-Type": "application/json", ...extra };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

async function check(resp: Response, what: string): Promise<Response> {
  if (!resp.ok) throw new Error(`supabase ${what}: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return resp;
}

export async function sbRpc<T>(env: Env, fn: string, args: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${base(env)}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: headers(env), body: JSON.stringify(args),
  });
  return (await (await check(resp, `rpc ${fn}`)).json()) as T;
}

export async function sbSelect<T>(env: Env, query: string): Promise<T> {
  const resp = await fetch(`${base(env)}/rest/v1/${query}`, { headers: headers(env) });
  return (await (await check(resp, `select ${query.split("?")[0]}`)).json()) as T;
}

export async function sbInsert(env: Env, table: string, rows: unknown[]): Promise<void> {
  if (!rows.length) return;
  const resp = await fetch(`${base(env)}/rest/v1/${table}`, {
    method: "POST", headers: headers(env, { Prefer: "return=minimal" }), body: JSON.stringify(rows),
  });
  await check(resp, `insert ${table}`);
}

// Permanently delete a sign-in account (Auth admin API). Every user table
// references auth.users with ON DELETE CASCADE, so the watchlist, alert
// settings, devices and alert log go with it.
export async function sbDeleteUser(env: Env, userId: string): Promise<void> {
  const resp = await fetch(`${base(env)}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE", headers: headers(env),
  });
  await check(resp, "delete user");
}

export async function sbDeleteSubscription(env: Env, endpoint: string): Promise<void> {
  const resp = await fetch(
    `${base(env)}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: headers(env, { Prefer: "return=minimal" }) },
  );
  await check(resp, "delete push_subscriptions");
}
