-- TINY CONVOY — expedition sessions, leaderboard and profiles.
--
-- Design rule: the browser can read the board and nothing else. Every write
-- goes through a Vercel function using the service-role key, which is the only
-- thing that ever computes a score. Row Level Security is on everywhere, and
-- the anon role is granted exactly one privilege: SELECT on finished runs.

create extension if not exists "pgcrypto";

-- ── Sessions ────────────────────────────────────────────────────────────────
-- One row per started expedition. `started_at` is the server's stopwatch: a
-- client cannot claim a duration shorter than the gap between this and the
-- submission.

create table if not exists public.expedition_sessions (
  id           uuid primary key,
  board        text        not null check (board ~ '^[A-Za-z0-9:_-]+$' and length(board) <= 64),
  mission_id   text        not null check (length(mission_id) <= 64),
  player_name  text        not null default 'Anonymous Driver' check (length(player_name) <= 18),
  seed         bigint      not null default 0,
  started_at   timestamptz not null default now(),
  submitted_at timestamptz,
  score        integer     check (score is null or (score >= 0 and score <= 4000)),
  rejected     text,
  -- Pinned at session start from mission-declared constants, not from the
  -- client's own telemetry, so a submission can't tune its own reference
  -- values after the fact. Null means "the session predates this column" or
  -- "the submitted mission value was out of range" — submit.ts falls back to
  -- the telemetry's own par in that case.
  par_time_sec integer     check (par_time_sec is null or (par_time_sec between 60 and 7200)),
  fuel_par     real        check (fuel_par is null or (fuel_par between 1 and 1000)),
  ip_hash      text,
  created_at   timestamptz not null default now()
);

create index if not exists expedition_sessions_board_idx on public.expedition_sessions (board, started_at desc);
create index if not exists expedition_sessions_open_idx on public.expedition_sessions (submitted_at) where submitted_at is null;

-- ── Leaderboard ─────────────────────────────────────────────────────────────
-- One row per accepted run. `session_id` is unique, which is what makes
-- submission idempotent: a replayed submit collides instead of stacking.

create table if not exists public.leaderboard_entries (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid        not null unique references public.expedition_sessions (id) on delete cascade,
  board           text        not null check (board ~ '^[A-Za-z0-9:_-]+$' and length(board) <= 64),
  mission_id      text        not null check (length(mission_id) <= 64),
  player_name     text        not null check (length(player_name) between 1 and 18),
  score           integer     not null check (score >= 0 and score <= 4000),
  duration_sec    integer     not null check (duration_sec > 0 and duration_sec <= 14400),
  cargo_condition real        not null check (cargo_condition between 0 and 1),
  fuel_used       real        not null check (fuel_used >= 0 and fuel_used <= 5000),
  damage_taken    real        not null check (damage_taken between 0 and 1),
  optional_found  integer     not null default 0 check (optional_found between 0 and 8),
  completed       boolean     not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists leaderboard_board_score_idx
  on public.leaderboard_entries (board, score desc, duration_sec asc)
  where completed;

create index if not exists leaderboard_player_idx on public.leaderboard_entries (board, player_name);

-- ── Profiles (optional cloud mirror of local progress) ──────────────────────
-- Purely a convenience so a player can pick the same convoy up on another
-- machine. The game is fully playable with none of this.

create table if not exists public.player_profiles (
  id           uuid primary key default gen_random_uuid(),
  local_id     text        not null unique check (length(local_id) <= 64),
  display_name text        not null default 'Anonymous Driver' check (length(display_name) <= 18),
  scrap        integer     not null default 0 check (scrap >= 0),
  reputation   integer     not null default 0 check (reputation >= 0),
  season_points integer    not null default 0 check (season_points >= 0),
  payload      jsonb       not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ── Row Level Security ──────────────────────────────────────────────────────

alter table public.expedition_sessions enable row level security;
alter table public.leaderboard_entries enable row level security;
alter table public.player_profiles     enable row level security;

-- Sessions: no policy at all for anon/authenticated. The service role bypasses
-- RLS, so only the server can create or read them. This is deliberate — a
-- readable session table would leak the ticket material.
drop policy if exists "sessions are server-only" on public.expedition_sessions;

-- Leaderboard: anyone may read completed runs. Nobody may write.
drop policy if exists "leaderboard is publicly readable" on public.leaderboard_entries;
create policy "leaderboard is publicly readable"
  on public.leaderboard_entries
  for select
  to anon, authenticated
  using (completed);

-- Profiles: server-only for now. When wallet-linked accounts land, this becomes
-- a policy keyed on auth.uid().
drop policy if exists "profiles are server-only" on public.player_profiles;

-- Belt and braces: revoke the default grants Supabase hands the anon role, then
-- re-grant only the one read the game needs.
revoke all on public.expedition_sessions from anon, authenticated;
revoke all on public.player_profiles     from anon, authenticated;
revoke all on public.leaderboard_entries from anon, authenticated;
grant select on public.leaderboard_entries to anon, authenticated;

-- ── Housekeeping ────────────────────────────────────────────────────────────
-- Abandoned sessions are noise. Run this from a scheduled function or pg_cron.

create or replace function public.prune_stale_sessions() returns void
language sql
security definer
set search_path = public
as $$
  delete from public.expedition_sessions
  where submitted_at is null
    and started_at < now() - interval '6 hours';
$$;

revoke all on function public.prune_stale_sessions() from anon, authenticated;
