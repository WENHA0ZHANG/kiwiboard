import type { Env } from "./types";

export interface AuthUser {
  id: string;
  email: string;
}

// Resolve the caller from a Supabase access token (`Authorization: Bearer …`).
// We ask Supabase Auth itself (`GET /auth/v1/user`) instead of verifying the
// JWT locally, so this works with both the legacy HS256 secret and the newer
// asymmetric signing keys, and the Worker needs no extra secret — only the
// project URL and the public anon key.
export async function getSupabaseUser(request: Request, env: Env): Promise<AuthUser | null> {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  const base = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!match || !base || !env.SUPABASE_ANON_KEY) return null;
  try {
    const resp = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${match[1]}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!resp.ok) return null;
    const u = (await resp.json()) as { id?: string; email?: string; email_confirmed_at?: string | null };
    // Only trust confirmed addresses: an unconfirmed sign-up must not be able
    // to claim an admin's email.
    if (!u.id || !u.email || !u.email_confirmed_at) return null;
    return { id: u.id, email: u.email.toLowerCase() };
  } catch {
    return null;
  }
}

// ADMIN_EMAILS is a Worker secret: comma/space separated list of emails.
export function isAdmin(user: AuthUser | null, env: Env): boolean {
  if (!user) return false;
  const admins = (env.ADMIN_EMAILS || "")
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean);
  return admins.includes(user.email);
}
