-- ═════════════════════════════════════════════════════════════════════════════
-- Poor Trader — Supabase schema (per-user data only).
-- Market data (indicators, regime, quotes) stays in Cloudflare D1; Supabase only
-- holds who the user is and what they chose: watchlists, alert prefs, devices.
--
-- How to run: Supabase Dashboard → SQL Editor → paste this file → Run.
-- Safe to re-run (idempotent).
--
-- Access model
--   • Browser (anon key + user's login JWT): Row Level Security limits every
--     query to the signed-in user's own rows.
--   • Cloudflare Worker (service_role key, a Worker secret): bypasses RLS to
--     find alert recipients, prune dead push endpoints and write the log.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── 1. Watchlists ────────────────────────────────────────────────────────────
-- list = 'watchlist' → the Watchlist tab;  'market' → Stocks table on Market tab.
create table if not exists public.watchlist_items (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  list       text        not null default 'watchlist' check (list in ('watchlist', 'market')),
  symbol     text        not null check (symbol ~ '^[A-Z0-9^][A-Z0-9.=^-]{0,14}$'),
  name       text        check (char_length(name) <= 120),
  note       text        check (char_length(note) <= 500),
  sort_order integer     not null default 0,
  pinned     boolean     not null default false,
  added_at   timestamptz not null default now(),
  primary key (user_id, list, symbol)
);
alter table public.watchlist_items enable row level security;

drop policy if exists "watchlist: read own"   on public.watchlist_items;
drop policy if exists "watchlist: insert own" on public.watchlist_items;
drop policy if exists "watchlist: update own" on public.watchlist_items;
drop policy if exists "watchlist: delete own" on public.watchlist_items;
create policy "watchlist: read own"   on public.watchlist_items for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "watchlist: insert own" on public.watchlist_items for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "watchlist: update own" on public.watchlist_items for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "watchlist: delete own" on public.watchlist_items for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Max 100 symbols per list per user (keeps the Worker's Yahoo fetches bounded).
-- Rows that already exist don't count, so an upsert of existing symbols
-- (e.g. "copy the shared list" twice) never trips the cap.
create or replace function public.enforce_watchlist_cap()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.watchlist_items w
                 where w.user_id = new.user_id and w.list = new.list and w.symbol = new.symbol)
     and (select count(*) from public.watchlist_items w
          where w.user_id = new.user_id and w.list = new.list) >= 100 then
    raise exception 'watchlist limit reached (100 symbols per list)';
  end if;
  return new;
end $$;
drop trigger if exists watchlist_cap on public.watchlist_items;
create trigger watchlist_cap before insert on public.watchlist_items
  for each row execute function public.enforce_watchlist_cap();

-- Drag-to-reorder in one call: sort_order = position in p_symbols.
-- security invoker → RLS still applies; it can only touch the caller's rows.
-- Browser: supabase.rpc('reorder_watchlist', { p_list: 'watchlist', p_symbols: [...] })
create or replace function public.reorder_watchlist(p_list text, p_symbols text[])
returns void
language sql security invoker set search_path = '' as $$
  update public.watchlist_items w
     set sort_order = o.ord - 1
    from unnest(p_symbols) with ordinality as o(symbol, ord)
   where w.user_id = auth.uid() and w.list = p_list and w.symbol = o.symbol;
$$;
revoke all on function public.reorder_watchlist(text, text[]) from public, anon;
grant execute on function public.reorder_watchlist(text, text[]) to authenticated;


-- ── 2. Notification preferences (one row per user; missing row = defaults) ────
create table if not exists public.notification_prefs (
  user_id       uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  regime_alerts boolean     not null default true,
  levels        text[]      not null default array['Strong Buy','Buy','Cautious Buy','Risk','Strong Risk'],
  updated_at    timestamptz not null default now(),
  constraint levels_valid check (
    levels <@ array['Strong Buy','Buy','Cautious Buy','Neutral','Caution','Risk','Strong Risk']
  )
);
alter table public.notification_prefs enable row level security;

drop policy if exists "prefs: read own"   on public.notification_prefs;
drop policy if exists "prefs: insert own" on public.notification_prefs;
drop policy if exists "prefs: update own" on public.notification_prefs;
create policy "prefs: read own"   on public.notification_prefs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "prefs: insert own" on public.notification_prefs for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "prefs: update own" on public.notification_prefs for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);


-- ── 3. Push subscriptions (one row per browser / installed app) ──────────────
create table if not exists public.push_subscriptions (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint     text        not null unique check (endpoint like 'https://%'),
  p256dh       text        not null,
  auth         text        not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_push_at timestamptz,
  fail_count   integer     not null default 0
);
alter table public.push_subscriptions enable row level security;

drop policy if exists "push: read own"   on public.push_subscriptions;
drop policy if exists "push: delete own" on public.push_subscriptions;
create policy "push: read own"   on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "push: delete own" on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Inserts go through this RPC so a device that switches Google accounts simply
-- moves its endpoint to the new user instead of hitting the unique constraint.
-- Browser: supabase.rpc('save_push_subscription', { p_endpoint, p_p256dh, p_auth, p_user_agent })
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        created_at = now(),
        fail_count = 0;
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;


-- ── 4. Notification history (Worker writes; users can read their own) ─────────
create table if not exists public.notification_log (
  id      bigint      generated always as identity primary key,
  user_id uuid        not null references auth.users (id) on delete cascade,
  kind    text        not null,          -- 'regime' (room for per-stock alerts later)
  title   text        not null,
  body    text,
  url     text,
  sent_at timestamptz not null default now()
);
create index if not exists notification_log_user_sent_idx
  on public.notification_log (user_id, sent_at desc);
alter table public.notification_log enable row level security;

drop policy if exists "log: read own" on public.notification_log;
create policy "log: read own" on public.notification_log for select to authenticated
  using ((select auth.uid()) = user_id);


-- ── 5. Recipients of a regime alert (Worker only) ────────────────────────────
-- Worker: POST /rest/v1/rpc/regime_alert_targets {"p_label":"Buy"} with service_role key.
create or replace function public.regime_alert_targets(p_label text)
returns table (user_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = '' as $$
  select s.user_id, s.endpoint, s.p256dh, s.auth
  from public.push_subscriptions s
  left join public.notification_prefs p on p.user_id = s.user_id
  where coalesce(p.regime_alerts, true)
    and p_label = any (coalesce(p.levels, array['Strong Buy','Buy','Cautious Buy','Risk','Strong Risk']));
$$;
revoke all on function public.regime_alert_targets(text) from public, anon, authenticated;
grant execute on function public.regime_alert_targets(text) to service_role;


-- ── 6. Explicit grants (needed when "expose new tables" is off in Data API) ───
grant select, insert, update, delete on public.watchlist_items    to authenticated;
grant select, insert, update         on public.notification_prefs to authenticated;
grant select, delete                 on public.push_subscriptions to authenticated;
grant select                         on public.notification_log   to authenticated;
grant all on public.watchlist_items, public.notification_prefs,
             public.push_subscriptions, public.notification_log to service_role;
