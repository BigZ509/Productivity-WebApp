-- =====================================================================
-- 20261117000200_phase_b_cutover.sql
--
-- ZBXP demo-rescue, PHASE B of 2: the cutover. Apply IMMEDIATELY before
-- deploying the new frontend. This BREAKS the pre-rescue frontend, which
-- writes XP and rows directly and calls the legacy RPCs revoked here.
-- Requires phase A (20261117000100).
--
--   * Quest lifecycle backfill; one-active-instance-per-quest model.
--   * XP reconciliation to a ledger-backed canonical balance (snapshot kept).
--   * Profile trigger, RLS reset, authenticated write revocation,
--     legacy RPC revocation.
--
-- Rollback notes: docs/DEPLOYMENT.md ("Rollback"). Idempotent.
-- =====================================================================

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

-- Statuses the old UI already treated as finished keep that meaning.
update public.user_active_quests
set status = 'completed', completed_at = coalesce(completed_at, selected_at)
where status = 'done';

update public.user_active_quests
set status = 'abandoned', abandoned_at = coalesce(abandoned_at, now())
where status in ('archived', 'inactive');

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
-- Profile creation trigger (new users start un-onboarded)
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
-- Revoke the legacy RPCs the pre-rescue frontend used.
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

    -- Legacy RPCs used by the pre-rescue frontend, plus internal helpers.
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

select pg_notify('pgrst', 'reload schema');
