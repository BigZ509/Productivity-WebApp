-- =====================================================================
-- 20261117000100_integrity_and_security.sql
--
-- ZBXP demo-rescue: XP integrity, quest lifecycle, guild authorization,
-- focus sessions, and function/table privilege hardening.
--
-- Design rules
--   * Additive: no tables or user rows are dropped. Old RPCs are kept
--     (EXECUTE is revoked from client roles so they can no longer be
--     abused); new behavior lives in new, uniquely named functions so this
--     migration never collides with drifted live signatures.
--   * Idempotent: safe to run more than once.
--   * Ledger-first XP: public.xp_events is the source of truth.
--     profiles.xp_total is the canonical balance and is only ever written
--     by public._award_xp() (SECURITY DEFINER, not client-callable).
--     profiles.total_xp is kept as a read-only mirror for old clients.
--
-- Rollback notes are in docs/DEPLOYMENT.md ("Rollback").
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 0. Schema normalization (columns that exist live but not in older
--    local migrations, plus new lifecycle columns)
-- ---------------------------------------------------------------------

alter table public.profiles add column if not exists total_xp integer not null default 0;
alter table public.profiles add column if not exists xp_total integer not null default 0;
alter table public.profiles add column if not exists player_class text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
-- New users choose their path during onboarding, so path must be nullable.
alter table public.profiles alter column path drop not null;

alter table public.quests add column if not exists repeat_cooldown_hours integer not null default 20;

alter table public.user_active_quests add column if not exists status text not null default 'active';
alter table public.user_active_quests add column if not exists selected_at timestamptz not null default now();
alter table public.user_active_quests add column if not exists completed_at timestamptz;
alter table public.user_active_quests add column if not exists abandoned_at timestamptz;

alter table public.quest_completions add column if not exists note text;
alter table public.quest_completions add column if not exists xp_awarded integer;
alter table public.quest_completions add column if not exists focus_session_id uuid;

alter table public.xp_events add column if not exists note text;

alter table public.groups add column if not exists description text not null default '';
alter table public.groups add column if not exists visibility text not null default 'public';
alter table public.groups add column if not exists max_members integer not null default 50;

-- ---------------------------------------------------------------------
-- 1. Quest lifecycle backfill
--    Old complete_quest() never moved rows out of 'active', so completed
--    quests lingered in the active list. Mark them completed.
-- ---------------------------------------------------------------------

update public.user_active_quests uaq
set status = 'completed',
    completed_at = coalesce(uaq.completed_at, qc.completed_at)
from public.quest_completions qc
where qc.active_quest_id = uaq.id
  and uaq.status is distinct from 'completed';

update public.user_active_quests uaq
set status = 'completed',
    completed_at = coalesce(uaq.completed_at, xe.created_at)
from public.xp_events xe
where xe.source_type = 'quest'
  and xe.source_id = uaq.id
  and xe.user_id = uaq.user_id
  and uaq.status is distinct from 'completed';

update public.user_active_quests
set status = 'active'
where status is null or status not in ('active', 'completed', 'abandoned');

update public.quest_completions qc
set xp_awarded = xe.amount
from public.xp_events xe
where qc.xp_awarded is null
  and xe.source_type = 'quest'
  and xe.source_id = qc.active_quest_id
  and xe.user_id = qc.user_id;

update public.quest_completions
set note = optional_note
where note is null and optional_note is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_active_quests_status_check') then
    alter table public.user_active_quests
      add constraint user_active_quests_status_check
      check (status in ('active', 'completed', 'abandoned'));
  end if;
end $$;

-- Repeatable quests: each acceptance is its own instance (and its own XP
-- idempotency key). Replace "one row per user+quest forever" with
-- "at most one ACTIVE instance per user+quest".
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.user_active_quests'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) = array['quest_id', 'user_id']
  loop
    execute format('alter table public.user_active_quests drop constraint %I', r.conname);
  end loop;
end $$;

create unique index if not exists user_active_quests_one_active_per_quest
  on public.user_active_quests (user_id, quest_id)
  where status = 'active';

create index if not exists user_active_quests_user_status_idx
  on public.user_active_quests (user_id, status, selected_at desc);

create index if not exists xp_events_user_created_idx
  on public.xp_events (user_id, created_at desc);

create index if not exists quest_completions_user_completed_idx
  on public.quest_completions (user_id, completed_at desc);

-- ---------------------------------------------------------------------
-- 2. Focus sessions (server-verified timing)
-- ---------------------------------------------------------------------

create table if not exists public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  active_quest_id uuid references public.user_active_quests (id) on delete set null,
  planned_seconds integer not null check (planned_seconds between 60 and 14400),
  focused_seconds integer check (focused_seconds is null or focused_seconds >= 0),
  status text not null default 'running' check (status in ('running', 'completed', 'abandoned')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  xp_awarded integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists focus_sessions_one_running_per_user
  on public.focus_sessions (user_id)
  where status = 'running';

create index if not exists focus_sessions_user_started_idx
  on public.focus_sessions (user_id, started_at desc);

alter table public.focus_sessions enable row level security;

-- ---------------------------------------------------------------------
-- 3. XP reconciliation (audit snapshot first, then reconcile)
--
--    Old clients wrote XP to two columns through different paths:
--      xp_total  <- server RPCs (ledger-backed)
--      total_xp  <- client fallbacks + "daily claim" (NOT ledger-backed),
--                   which also mirrored RPC awards.
--    Adding the columns together would double count. Instead:
--      canonical = greatest(xp_total, total_xp, ledger_sum)
--    i.e. never lower than what the user was shown, never a sum.
--    The gap (canonical - ledger_sum) is booked as ONE 'reconciliation'
--    ledger event dated at the profile's creation (so it does not inflate
--    weekly leaderboards). Afterwards: xp_total == sum(xp_events) for all.
--    The pre-change values are kept in xp_reconciliation_snapshots.
-- ---------------------------------------------------------------------

create table if not exists public.xp_reconciliation_snapshots (
  user_id uuid primary key references auth.users (id) on delete cascade,
  total_xp_before integer not null,
  xp_total_before integer not null,
  ledger_sum_before integer not null,
  canonical_xp integer not null,
  reconciliation_delta integer not null,
  snapshot_at timestamptz not null default now()
);

alter table public.xp_reconciliation_snapshots enable row level security;
revoke all on public.xp_reconciliation_snapshots from anon, authenticated;

with ledger as (
  select user_id, coalesce(sum(amount), 0)::int as total
  from public.xp_events
  group by user_id
)
insert into public.xp_reconciliation_snapshots
  (user_id, total_xp_before, xp_total_before, ledger_sum_before, canonical_xp, reconciliation_delta)
select
  p.id,
  coalesce(p.total_xp, 0),
  coalesce(p.xp_total, 0),
  coalesce(l.total, 0),
  greatest(coalesce(p.total_xp, 0), coalesce(p.xp_total, 0), coalesce(l.total, 0)),
  greatest(coalesce(p.total_xp, 0), coalesce(p.xp_total, 0), coalesce(l.total, 0)) - coalesce(l.total, 0)
from public.profiles p
left join ledger l on l.user_id = p.id
where exists (select 1 from auth.users u where u.id = p.id)
on conflict (user_id) do nothing;

insert into public.xp_events (user_id, source_type, source_id, amount, created_at, note)
select s.user_id, 'reconciliation', s.user_id, s.reconciliation_delta,
       coalesce(p.created_at, now()), 'Balance carried over from pre-ledger XP'
from public.xp_reconciliation_snapshots s
join public.profiles p on p.id = s.user_id
where s.reconciliation_delta > 0
on conflict do nothing;

with ledger as (
  select user_id, coalesce(sum(amount), 0)::int as total
  from public.xp_events
  group by user_id
)
update public.profiles p
set xp_total = coalesce(l.total, 0),
    total_xp = coalesce(l.total, 0)
from (select id from public.profiles) ids
left join ledger l on l.user_id = ids.id
where p.id = ids.id
  and (p.xp_total is distinct from coalesce(l.total, 0) or p.total_xp is distinct from coalesce(l.total, 0));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_xp_total_nonneg') then
    alter table public.profiles add constraint profiles_xp_total_nonneg check (xp_total >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'xp_events_amount_nonneg') then
    alter table public.xp_events add constraint xp_events_amount_nonneg check (amount >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_shape') then
    alter table public.profiles add constraint profiles_display_name_shape
      check (display_name is null or (char_length(btrim(display_name)) between 2 and 24 and position('@' in display_name) = 0))
      not valid;
  end if;
end $$;

-- total_xp is a mirror of the canonical xp_total.
create or replace function public._profiles_xp_mirror()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.total_xp := new.xp_total;
  return new;
end;
$$;

drop trigger if exists profiles_xp_mirror on public.profiles;
create trigger profiles_xp_mirror
  before insert or update on public.profiles
  for each row execute function public._profiles_xp_mirror();

-- ---------------------------------------------------------------------
-- 4. Internal helpers (NOT client-callable)
-- ---------------------------------------------------------------------

-- Award XP exactly once per (user, source_type, source_id).
-- The unique index on xp_events makes concurrent duplicates impossible:
-- the second inserter blocks on the first and then hits ON CONFLICT.
create or replace function public._award_xp(
  p_user_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_amount integer,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_amount is null or p_amount <= 0 then
    return 0;
  end if;

  insert into public.xp_events (user_id, source_type, source_id, amount, note)
  values (p_user_id, p_source_type, p_source_id, p_amount, p_note)
  on conflict (user_id, source_type, source_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 0;
  end if;

  update public.profiles
  set xp_total = xp_total + p_amount
  where id = p_user_id;

  return p_amount;
end;
$$;

create or replace function public._require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using hint = 'NOT_AUTHENTICATED';
  end if;
  return v_uid;
end;
$$;

create or replace function public._safe_display_name(p_display_name text, p_username text, p_user_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(btrim(p_display_name), '') is not null and position('@' in p_display_name) = 0 then btrim(p_display_name)
    when nullif(btrim(p_username), '') is not null and position('@' in p_username) = 0 then btrim(p_username)
    else 'Hunter#' || right(replace(p_user_id::text, '-', ''), 4)
  end;
$$;

-- Used by RLS policies; SECURITY DEFINER avoids recursive policy evaluation.
create or replace function public._is_guild_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = auth.uid()
  );
$$;

-- Workout streak: consecutive completed days ending today or yesterday.
create or replace function public._recalculate_workout_streak(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anchor date;
  v_day date;
  v_streak integer := 0;
  v_longest integer := 0;
  v_run integer := 0;
  v_prev date;
  r record;
begin
  select max(log_date) into v_anchor
  from public.workout_logs
  where user_id = p_user_id and completed and log_date <= current_date + 1;

  if v_anchor is not null and v_anchor >= current_date - 1 then
    v_day := v_anchor;
    while exists (
      select 1 from public.workout_logs
      where user_id = p_user_id and completed and log_date = v_day
    ) loop
      v_streak := v_streak + 1;
      v_day := v_day - 1;
    end loop;
  end if;

  for r in
    select log_date from public.workout_logs
    where user_id = p_user_id and completed
    order by log_date
  loop
    if v_prev is not null and r.log_date = v_prev + 1 then
      v_run := v_run + 1;
    else
      v_run := 1;
    end if;
    v_longest := greatest(v_longest, v_run);
    v_prev := r.log_date;
  end loop;

  update public.profiles
  set current_streak = v_streak,
      longest_streak = greatest(coalesce(longest_streak, 0), v_longest, v_streak)
  where id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Profile RPCs
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, 'Hunter#' || right(replace(new.id::text, '-', ''), 4))
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created_profile') then
    create trigger on_auth_user_created_profile
      after insert on auth.users
      for each row execute function public.handle_new_user_profile();
  end if;
end $$;

create or replace function public.ensure_profile()
returns table (
  id uuid,
  username text,
  display_name text,
  path text,
  xp_total integer,
  current_streak integer,
  longest_streak integer,
  last_workout_date date,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
begin
  insert into public.profiles (id, username)
  values (v_uid, 'Hunter#' || right(replace(v_uid::text, '-', ''), 4))
  on conflict on constraint profiles_pkey do nothing;

  return query
  select p.id,
         p.username,
         public._safe_display_name(p.display_name, p.username, p.id),
         p.path,
         p.xp_total,
         coalesce(p.current_streak, 0),
         coalesce(p.longest_streak, 0),
         p.last_workout_date,
         p.created_at
  from public.profiles p
  where p.id = v_uid;
end;
$$;

create or replace function public.set_identity(p_display_name text, p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_uid();
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if char_length(v_name) < 2 or char_length(v_name) > 24 then
    raise exception 'Display name must be 2-24 characters.' using hint = 'INVALID_NAME';
  end if;
  if position('@' in v_name) > 0 then
    raise exception 'Display name cannot contain "@".' using hint = 'INVALID_NAME';
  end if;
  if p_path is null or p_path not in ('HUNTER', 'HEAVENLY_DEMON') then
    raise exception 'Choose a valid path.' using hint = 'INVALID_PATH';
  end if;

  update public.profiles
  set display_name = v_name,
      username = v_name,
      path = p_path
  where id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Quest lifecycle RPCs
--    Available -> (accept) -> Active -> (complete) -> Completed/History
--                                  \-> (abandon)  -> Abandoned
-- ---------------------------------------------------------------------

create or replace function public.accept_quest(p_quest_id uuid)
returns table (active_quest_id uuid, quest_id uuid, status text, selected_at timestamptz, already_active boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_limit constant integer := 5;
  v_quest record;
  v_path text;
  v_existing record;
  v_last_completed timestamptz;
  v_active_count integer;
  v_new_id uuid;
  v_new_selected timestamptz;
begin
  -- Serialize accepts per user so the active limit cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('zbxp.accept:' || v_uid::text, 0));

  select q.id, q.path, q.is_active, q.repeat_cooldown_hours, q.title
  into v_quest
  from public.quests q
  where q.id = p_quest_id;

  if v_quest.id is null or not coalesce(v_quest.is_active, true) then
    raise exception 'That quest is not available.' using hint = 'QUEST_UNAVAILABLE';
  end if;

  select p.path into v_path from public.profiles p where p.id = v_uid;
  if v_path is null then
    raise exception 'Choose your path before accepting quests.' using hint = 'PATH_REQUIRED';
  end if;
  if v_quest.path is distinct from v_path then
    raise exception 'That quest belongs to a different path.' using hint = 'QUEST_UNAVAILABLE';
  end if;

  select uaq.id, uaq.selected_at into v_existing
  from public.user_active_quests uaq
  where uaq.user_id = v_uid and uaq.quest_id = p_quest_id and uaq.status = 'active'
  limit 1;

  if v_existing.id is not null then
    return query select v_existing.id, p_quest_id, 'active'::text, v_existing.selected_at, true;
    return;
  end if;

  select max(uaq.completed_at) into v_last_completed
  from public.user_active_quests uaq
  where uaq.user_id = v_uid and uaq.quest_id = p_quest_id and uaq.status = 'completed';

  if v_last_completed is not null
     and v_last_completed > now() - make_interval(hours => greatest(coalesce(v_quest.repeat_cooldown_hours, 20), 0)) then
    raise exception 'You completed this quest recently. It can be accepted again after %.',
      to_char((v_last_completed + make_interval(hours => v_quest.repeat_cooldown_hours)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      using hint = 'QUEST_COOLDOWN';
  end if;

  select count(*)::int into v_active_count
  from public.user_active_quests uaq
  where uaq.user_id = v_uid and uaq.status = 'active';

  if v_active_count >= v_limit then
    raise exception 'You already have % active quests. Complete or abandon one first.', v_limit
      using hint = 'QUEST_LIMIT';
  end if;

  insert into public.user_active_quests (user_id, quest_id, status, selected_at)
  values (v_uid, p_quest_id, 'active', now())
  returning id, user_active_quests.selected_at into v_new_id, v_new_selected;

  return query select v_new_id, p_quest_id, 'active'::text, v_new_selected, false;
end;
$$;

create or replace function public.complete_active_quest(
  p_active_quest_id uuid,
  p_note text default null,
  p_focus_session_id uuid default null
)
returns table (
  active_quest_id uuid,
  xp_awarded integer,
  newly_completed boolean,
  completed_at timestamptz,
  xp_total integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_instance record;
  v_reward integer;
  v_awarded integer;
  v_now timestamptz := now();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_prev_award integer;
  v_focus_id uuid;
begin
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Completion notes are limited to 500 characters.' using hint = 'NOTE_TOO_LONG';
  end if;

  -- Row lock serializes concurrent completions of the same instance.
  select uaq.id, uaq.status, uaq.completed_at, uaq.quest_id
  into v_instance
  from public.user_active_quests uaq
  where uaq.id = p_active_quest_id and uaq.user_id = v_uid
  for update;

  if v_instance.id is null then
    -- Also covers other users' instances, without revealing they exist.
    raise exception 'Quest not found.' using hint = 'QUEST_NOT_FOUND';
  end if;

  if v_instance.status = 'abandoned' then
    raise exception 'This quest was abandoned and cannot be completed.' using hint = 'QUEST_ABANDONED';
  end if;

  if v_instance.status = 'completed' then
    select coalesce(qc.xp_awarded, 0) into v_prev_award
    from public.quest_completions qc where qc.active_quest_id = v_instance.id;
    return query
      select v_instance.id, coalesce(v_prev_award, 0), false, v_instance.completed_at,
             (select p.xp_total from public.profiles p where p.id = v_uid);
    return;
  end if;

  -- Only link focus sessions that belong to the caller.
  select fs.id into v_focus_id
  from public.focus_sessions fs
  where fs.id = p_focus_session_id and fs.user_id = v_uid;

  select q.xp_reward into v_reward from public.quests q where q.id = v_instance.quest_id;
  v_reward := greatest(coalesce(v_reward, 0), 0);

  v_awarded := public._award_xp(v_uid, 'quest', v_instance.id, v_reward, null);

  insert into public.quest_completions (active_quest_id, user_id, optional_note, note, xp_awarded, focus_session_id, completed_at)
  values (v_instance.id, v_uid, v_note, v_note, v_reward, v_focus_id, v_now)
  on conflict (active_quest_id) do update
    set note = coalesce(excluded.note, public.quest_completions.note),
        xp_awarded = coalesce(public.quest_completions.xp_awarded, excluded.xp_awarded);

  update public.user_active_quests
  set status = 'completed', completed_at = v_now
  where id = v_instance.id;

  return query
    select v_instance.id, v_awarded, true, v_now,
           (select p.xp_total from public.profiles p where p.id = v_uid);
end;
$$;

create or replace function public.abandon_active_quest(p_active_quest_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_uid();
  v_status text;
begin
  select uaq.status into v_status
  from public.user_active_quests uaq
  where uaq.id = p_active_quest_id and uaq.user_id = v_uid
  for update;

  if v_status is null then
    raise exception 'Quest not found.' using hint = 'QUEST_NOT_FOUND';
  end if;
  if v_status <> 'active' then
    return;
  end if;

  update public.user_active_quests
  set status = 'abandoned', abandoned_at = now()
  where id = p_active_quest_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Workouts
-- ---------------------------------------------------------------------

create or replace function public.record_workout(
  p_date date,
  p_completed boolean,
  p_payload jsonb default '{}'::jsonb
)
returns table (log_id uuid, xp_awarded integer, bonus_xp integer, current_streak integer, longest_streak integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_log_id uuid;
  v_base constant integer := 40;
  v_bonus integer := 0;
  v_awarded integer := 0;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_notes text := left(coalesce(v_payload->>'notes', ''), 500);
  v_walk boolean := coalesce((v_payload->>'bonus_walk_45')::boolean, false);
  v_run boolean := coalesce((v_payload->>'bonus_run_45')::boolean, false);
begin
  if p_date is null or p_date < current_date - 2 or p_date > current_date + 1 then
    raise exception 'Workouts can only be logged for today or the previous two days.' using hint = 'WORKOUT_DATE';
  end if;
  if pg_column_size(v_payload) > 4000 then
    raise exception 'Workout details are too large.' using hint = 'PAYLOAD_TOO_LARGE';
  end if;

  v_payload := jsonb_build_object(
    'notes', v_notes,
    'bonus_walk_45', v_walk,
    'bonus_run_45', v_run,
    'plan_day', left(coalesce(v_payload->>'plan_day', ''), 120),
    'exercises_done', coalesce((v_payload->>'exercises_done')::int, 0)
  );

  insert into public.workout_logs (user_id, log_date, completed, payload)
  values (v_uid, p_date, coalesce(p_completed, false), v_payload)
  on conflict (user_id, log_date)
  do update set completed = excluded.completed or public.workout_logs.completed,
                payload = excluded.payload
  returning id into v_log_id;

  if coalesce(p_completed, false) then
    v_bonus := (case when v_walk then 10 else 0 end) + (case when v_run then 15 else 0 end);
    v_awarded := public._award_xp(v_uid, 'workout', v_log_id, v_base + v_bonus, null);
    update public.profiles set last_workout_date = greatest(coalesce(last_workout_date, p_date), p_date) where id = v_uid;
  end if;

  perform public._recalculate_workout_streak(v_uid);

  return query
    select v_log_id, v_awarded, case when v_awarded > 0 then v_bonus else 0 end,
           coalesce(p.current_streak, 0), coalesce(p.longest_streak, 0)
    from public.profiles p where p.id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Focus session RPCs
--    The server records started_at. Completion requires that real wall
--    time has elapsed, so client clock or timer manipulation cannot mint
--    XP. XP: 1 per full 5 focused minutes, capped at 48/day.
-- ---------------------------------------------------------------------

create or replace function public.start_focus_session(p_planned_seconds integer, p_active_quest_id uuid default null)
returns table (session_id uuid, started_at timestamptz, planned_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_id uuid;
  v_started timestamptz;
begin
  if p_planned_seconds is null or p_planned_seconds < 60 or p_planned_seconds > 14400 then
    raise exception 'Focus sessions must be between 1 and 240 minutes.' using hint = 'FOCUS_DURATION';
  end if;

  if p_active_quest_id is not null and not exists (
    select 1 from public.user_active_quests uaq
    where uaq.id = p_active_quest_id and uaq.user_id = v_uid and uaq.status = 'active'
  ) then
    raise exception 'Link the session to one of your active quests.' using hint = 'QUEST_NOT_FOUND';
  end if;

  -- Only one running session per user; a new start supersedes the old one.
  update public.focus_sessions fs
  set status = 'abandoned', ended_at = now()
  where fs.user_id = v_uid and fs.status = 'running';

  insert into public.focus_sessions (user_id, active_quest_id, planned_seconds)
  values (v_uid, p_active_quest_id, p_planned_seconds)
  returning id, focus_sessions.started_at into v_id, v_started;

  return query select v_id, v_started, p_planned_seconds;
end;
$$;

create or replace function public.complete_focus_session(p_session_id uuid, p_focused_seconds integer)
returns table (session_id uuid, focused_seconds integer, xp_awarded integer, newly_completed boolean, ended_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_s record;
  v_elapsed integer;
  v_focused integer;
  v_raw_xp integer;
  v_today_xp integer;
  v_xp integer;
  v_awarded integer;
  v_now timestamptz := now();
  v_tolerance constant integer := 5;
begin
  select fs.* into v_s
  from public.focus_sessions fs
  where fs.id = p_session_id and fs.user_id = v_uid
  for update;

  if v_s.id is null then
    raise exception 'Focus session not found.' using hint = 'FOCUS_NOT_FOUND';
  end if;

  if v_s.status = 'completed' then
    return query select v_s.id, v_s.focused_seconds, v_s.xp_awarded, false, v_s.ended_at;
    return;
  end if;

  if v_s.status <> 'running' then
    raise exception 'This focus session is no longer running.' using hint = 'FOCUS_NOT_RUNNING';
  end if;

  v_elapsed := floor(extract(epoch from (v_now - v_s.started_at)))::int;
  v_focused := least(coalesce(p_focused_seconds, 0), v_s.planned_seconds);

  if v_focused < v_s.planned_seconds - v_tolerance then
    raise exception 'The session has not reached its planned duration yet.' using hint = 'FOCUS_INCOMPLETE';
  end if;
  if v_elapsed + v_tolerance < v_focused then
    raise exception 'Not enough time has passed to complete this session.' using hint = 'FOCUS_TOO_FAST';
  end if;

  v_raw_xp := floor(v_focused / 300.0)::int;
  select coalesce(sum(xe.amount), 0)::int into v_today_xp
  from public.xp_events xe
  where xe.user_id = v_uid and xe.source_type = 'focus'
    and xe.created_at >= date_trunc('day', v_now);
  v_xp := greatest(0, least(v_raw_xp, 48 - v_today_xp));

  v_awarded := public._award_xp(v_uid, 'focus', v_s.id, v_xp, null);

  update public.focus_sessions
  set status = 'completed', focused_seconds = v_focused, ended_at = v_now, xp_awarded = v_awarded
  where id = v_s.id;

  return query select v_s.id, v_focused, v_awarded, true, v_now;
end;
$$;

create or replace function public.cancel_focus_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_uid();
begin
  update public.focus_sessions
  set status = 'abandoned', ended_at = now()
  where id = p_session_id and user_id = v_uid and status = 'running';
end;
$$;

-- ---------------------------------------------------------------------
-- 9. Guild RPCs
--    Public browsing/joining and invite-code joining are separate,
--    explicit operations. Invite codes are only visible to members.
-- ---------------------------------------------------------------------

create or replace function public._new_invite_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

create or replace function public.guild_create(p_name text, p_description text default '', p_visibility text default 'public')
returns table (group_id uuid, invite_code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_desc text := btrim(coalesce(p_description, ''));
  v_vis text := coalesce(p_visibility, 'public');
  v_id uuid;
  v_code text;
  v_owned integer;
begin
  if char_length(v_name) < 3 or char_length(v_name) > 40 then
    raise exception 'Guild names must be 3-40 characters.' using hint = 'INVALID_NAME';
  end if;
  if char_length(v_desc) > 280 then
    raise exception 'Guild descriptions are limited to 280 characters.' using hint = 'INVALID_DESCRIPTION';
  end if;
  if v_vis not in ('public', 'private') then
    raise exception 'Visibility must be public or private.' using hint = 'INVALID_VISIBILITY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zbxp.guild_create:' || v_uid::text, 0));
  select count(*)::int into v_owned from public.groups g where g.created_by = v_uid;
  if v_owned >= 3 then
    raise exception 'You can own up to 3 guilds.' using hint = 'GUILD_OWN_LIMIT';
  end if;

  loop
    v_code := public._new_invite_code();
    exit when not exists (select 1 from public.groups g where g.invite_code = v_code);
  end loop;

  insert into public.groups (name, created_by, invite_code, description, visibility)
  values (v_name, v_uid, v_code, v_desc, v_vis)
  returning id into v_id;

  insert into public.group_members (group_id, user_id, role)
  values (v_id, v_uid, 'owner')
  on conflict do nothing;

  return query select v_id, v_code;
end;
$$;

create or replace function public._guild_join(p_group_id uuid, p_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_count integer;
  v_rows integer;
begin
  if exists (select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_uid) then
    return false;
  end if;

  select g.max_members into v_max from public.groups g where g.id = p_group_id for update;
  select count(*)::int into v_count from public.group_members gm where gm.group_id = p_group_id;
  if v_count >= coalesce(v_max, 50) then
    raise exception 'This guild is full.' using hint = 'GUILD_FULL';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (p_group_id, p_uid, 'member')
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.guild_join_by_code(p_code text)
returns table (group_id uuid, name text, joined boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_group record;
  v_joined boolean;
begin
  if v_code !~ '^[A-Z0-9]{6,12}$' then
    raise exception 'Invite codes are 6-12 letters or numbers.' using hint = 'INVALID_CODE';
  end if;

  select g.id, g.name into v_group from public.groups g where g.invite_code = v_code;
  if v_group.id is null then
    raise exception 'No guild uses that invite code.' using hint = 'INVALID_CODE';
  end if;

  v_joined := public._guild_join(v_group.id, v_uid);
  return query select v_group.id, v_group.name, v_joined;
end;
$$;

create or replace function public.guild_join_public(p_group_id uuid)
returns table (group_id uuid, name text, joined boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_group record;
  v_joined boolean;
begin
  select g.id, g.name, g.visibility into v_group from public.groups g where g.id = p_group_id;
  if v_group.id is null or v_group.visibility <> 'public' then
    raise exception 'That guild is not open to the public.' using hint = 'GUILD_NOT_PUBLIC';
  end if;

  v_joined := public._guild_join(v_group.id, v_uid);
  return query select v_group.id, v_group.name, v_joined;
end;
$$;

create or replace function public.guild_leave(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public._require_uid();
  v_role text;
  v_successor uuid;
begin
  select gm.role into v_role
  from public.group_members gm
  where gm.group_id = p_group_id and gm.user_id = v_uid
  for update;

  if v_role is null then
    return;
  end if;

  delete from public.group_members where group_id = p_group_id and user_id = v_uid;

  if v_role = 'owner' then
    select gm.user_id into v_successor
    from public.group_members gm
    where gm.group_id = p_group_id
    order by gm.joined_at asc
    limit 1;
    if v_successor is not null then
      update public.group_members set role = 'owner'
      where group_id = p_group_id and user_id = v_successor;
    end if;
  end if;
end;
$$;

create or replace function public.guild_my_guilds()
returns table (
  group_id uuid,
  name text,
  description text,
  visibility text,
  invite_code text,
  role text,
  member_count integer,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.name, g.description, g.visibility, g.invite_code, gm.role,
         (select count(*)::int from public.group_members x where x.group_id = g.id),
         gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.user_id = auth.uid()
  order by gm.joined_at asc;
$$;

create or replace function public.guild_list_public(p_search text default null)
returns table (group_id uuid, name text, description text, member_count integer, max_members integer, is_member boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.name, g.description,
         (select count(*)::int from public.group_members x where x.group_id = g.id) as member_count,
         g.max_members,
         exists (select 1 from public.group_members m where m.group_id = g.id and m.user_id = auth.uid())
  from public.groups g
  where auth.uid() is not null
    and g.visibility = 'public'
    and (p_search is null or btrim(p_search) = '' or g.name ilike '%' || btrim(p_search) || '%')
  order by member_count desc, g.name asc
  limit 50;
$$;

-- Leaderboard + roster in one call. Members only. Exposes display names,
-- roles and XP only: no emails, no user ids.
create or replace function public.guild_leaderboard(p_group_id uuid, p_timeframe text default 'weekly')
returns table (
  standing integer,
  display_name text,
  role text,
  xp integer,
  total_xp integer,
  joined_at timestamptz,
  is_self boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public._require_uid();
  v_start timestamptz;
begin
  if not exists (select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = v_uid) then
    raise exception 'Only guild members can view this leaderboard.' using hint = 'NOT_A_MEMBER';
  end if;

  v_start := case when p_timeframe = 'weekly' then date_trunc('week', now()) else '-infinity'::timestamptz end;

  return query
  with members as (
    select gm.user_id, gm.role, gm.joined_at from public.group_members gm where gm.group_id = p_group_id
  ),
  sums as (
    select xe.user_id,
           coalesce(sum(xe.amount) filter (where xe.created_at >= v_start and xe.source_type <> 'reconciliation'), 0)::int as period_xp,
           coalesce(sum(xe.amount), 0)::int as all_xp
    from public.xp_events xe
    where xe.user_id in (select m.user_id from members m)
    group by xe.user_id
  )
  select
    (dense_rank() over (order by case when p_timeframe = 'weekly' then coalesce(s.period_xp, 0) else coalesce(s.all_xp, 0) end desc))::int,
    public._safe_display_name(p.display_name, p.username, m.user_id),
    m.role,
    case when p_timeframe = 'weekly' then coalesce(s.period_xp, 0) else coalesce(s.all_xp, 0) end,
    coalesce(s.all_xp, 0),
    m.joined_at,
    m.user_id = v_uid
  from members m
  left join sums s on s.user_id = m.user_id
  left join public.profiles p on p.id = m.user_id
  order by 4 desc, 2 asc;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. Row Level Security: replace every policy on the tables this app
--     owns. Live policies drifted from the repo and permissive policies
--     are OR-ed, so unknown ones are reset rather than left in place.
-- ---------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'profiles', 'user_active_quests', 'quest_completions', 'xp_events',
        'groups', 'group_members', 'focus_sessions', 'workout_logs',
        'user_selected_workout_plans', 'quests', 'workout_plans', 'workout_plan_days'
      )
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.user_active_quests enable row level security;
alter table public.quest_completions enable row level security;
alter table public.xp_events enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.workout_logs enable row level security;
alter table public.user_selected_workout_plans enable row level security;
alter table public.quests enable row level security;
alter table public.workout_plans enable row level security;
alter table public.workout_plan_days enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

create policy uaq_select_own on public.user_active_quests
  for select to authenticated using (user_id = auth.uid());

create policy quest_completions_select_own on public.quest_completions
  for select to authenticated using (user_id = auth.uid());

create policy xp_events_select_own on public.xp_events
  for select to authenticated using (user_id = auth.uid());

create policy focus_sessions_select_own on public.focus_sessions
  for select to authenticated using (user_id = auth.uid());

create policy workout_logs_select_own on public.workout_logs
  for select to authenticated using (user_id = auth.uid());

create policy selected_plan_select_own on public.user_selected_workout_plans
  for select to authenticated using (user_id = auth.uid());

create policy quests_select_auth on public.quests
  for select to authenticated using (true);

create policy workout_plans_select_auth on public.workout_plans
  for select to authenticated using (true);

create policy workout_plan_days_select_auth on public.workout_plan_days
  for select to authenticated using (true);

create policy groups_select_visible on public.groups
  for select to authenticated using (visibility = 'public' or public._is_guild_member(id));

create policy group_members_select_guildmates on public.group_members
  for select to authenticated using (user_id = auth.uid() or public._is_guild_member(group_id));

-- ---------------------------------------------------------------------
-- 11. Table privileges: clients read their own rows; every write goes
--     through a validated SECURITY DEFINER RPC.
-- ---------------------------------------------------------------------

revoke all on
  public.profiles, public.user_active_quests, public.quest_completions, public.xp_events,
  public.groups, public.group_members, public.focus_sessions, public.workout_logs,
  public.user_selected_workout_plans, public.quests, public.workout_plans, public.workout_plan_days
from anon;

revoke insert, update, delete, truncate, references, trigger on
  public.profiles, public.user_active_quests, public.quest_completions, public.xp_events,
  public.groups, public.group_members, public.focus_sessions, public.workout_logs,
  public.user_selected_workout_plans, public.quests, public.workout_plans, public.workout_plan_days
from authenticated;

grant select on
  public.profiles, public.user_active_quests, public.quest_completions, public.xp_events,
  public.group_members, public.focus_sessions, public.workout_logs,
  public.user_selected_workout_plans, public.quests, public.workout_plans, public.workout_plan_days
to authenticated;

-- groups: hide invite_code (members get it from guild_my_guilds()).
revoke select on public.groups from authenticated;
grant select (id, name, description, visibility, max_members, created_at) on public.groups to authenticated;

-- ---------------------------------------------------------------------
-- 12. Function privileges
--     Postgres grants EXECUTE to PUBLIC by default and Supabase also
--     grants anon. Remove both everywhere in public (excluding extension
--     functions), then grant authenticated only the client API.
-- ---------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);

    -- Legacy and internal functions: no client access at all.
    if r.proname in (
      'complete_quest', 'select_quest', 'log_workout', 'get_leaderboard',
      'create_guild', 'join_guild_by_code', 'recalculate_streaks', 'is_qa_user',
      'handle_new_user_profile', 'set_updated_at',
      '_award_xp', '_recalculate_workout_streak', '_guild_join', '_new_invite_code',
      '_profiles_xp_mirror', '_safe_display_name', '_require_uid'
    ) then
      execute format('revoke execute on function %s from authenticated', r.sig);
    end if;
  end loop;
end $$;

grant execute on function
  public.ensure_profile(),
  public.set_identity(text, text),
  public.accept_quest(uuid),
  public.complete_active_quest(uuid, text, uuid),
  public.abandon_active_quest(uuid),
  public.record_workout(date, boolean, jsonb),
  public.start_focus_session(integer, uuid),
  public.complete_focus_session(uuid, integer),
  public.cancel_focus_session(uuid),
  public.guild_create(text, text, text),
  public.guild_join_by_code(text),
  public.guild_join_public(uuid),
  public.guild_leave(uuid),
  public.guild_my_guilds(),
  public.guild_list_public(text),
  public.guild_leaderboard(uuid, text),
  public._is_guild_member(uuid)
to authenticated;

-- select_workout_plan only stores the chosen plan; keep it for authenticated.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'select_workout_plan') then
    execute 'grant execute on function public.select_workout_plan(uuid) to authenticated';
  end if;
end $$;

-- Future functions created by the migration role do not default to PUBLIC/anon.
do $$
begin
  execute 'alter default privileges in schema public revoke execute on functions from public';
  execute 'alter default privileges in schema public revoke execute on functions from anon';
exception when others then
  raise notice 'Could not alter default privileges: %', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
