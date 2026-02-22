-- ZBXP Core Gameplay + Security Migration
-- React + Supabase MVP with secure server-side XP awarding.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------
-- Profiles (extends existing profile model)
-- ------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  is_qa boolean not null default false,
  perks jsonb not null default '{}'::jsonb,
  path_key text,
  total_xp integer not null default 0,
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists is_qa boolean not null default false;
alter table public.profiles add column if not exists perks jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists path_key text;
alter table public.profiles add column if not exists total_xp integer not null default 0;
alter table public.profiles add column if not exists current_streak integer not null default 0;
alter table public.profiles add column if not exists longest_streak integer not null default 0;
alter table public.profiles add column if not exists created_at timestamptz not null default now();

DO $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_path_key_check'
  ) then
    alter table public.profiles
      add constraint profiles_path_key_check
      check (path_key is null or path_key in ('HEAVENLY_DEMON', 'HUNTER'));
  end if;
end
$$;

-- Trigger: auto-create profile when auth user is created.
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

DO $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'on_auth_user_created_profile'
  ) then
    create trigger on_auth_user_created_profile
      after insert on auth.users
      for each row execute function public.handle_new_user_profile();
  end if;
end
$$;

-- ------------------------------------------------------------------
-- Quest system
-- ------------------------------------------------------------------
create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  path_key text not null check (path_key in ('HEAVENLY_DEMON', 'HUNTER')),
  title text not null,
  description text,
  flavor_text text,
  category text not null check (category in ('study', 'coding', 'gym', 'business')),
  difficulty text not null check (difficulty in ('easy', 'med', 'hard')),
  xp_reward integer not null check (xp_reward > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (path_key, title)
);

create table if not exists public.user_active_quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  quest_id uuid not null references public.quests (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  selected_at timestamptz not null default now(),
  completed_at timestamptz,
  note text
);

create unique index if not exists idx_user_active_quests_unique_active
  on public.user_active_quests (user_id, quest_id)
  where status = 'active';

create table if not exists public.quest_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  active_quest_id uuid not null references public.user_active_quests (id) on delete cascade,
  quest_id uuid not null references public.quests (id) on delete cascade,
  note text,
  completed_at timestamptz not null default now(),
  unique (active_quest_id)
);

-- ------------------------------------------------------------------
-- XP event ledger (server-side awards only)
-- ------------------------------------------------------------------
create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_type text not null check (source_type in ('quest_completion', 'workout_log')),
  source_id uuid not null,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);

-- ------------------------------------------------------------------
-- Gym module
-- ------------------------------------------------------------------
create table if not exists public.workout_plans (
  id uuid primary key default gen_random_uuid(),
  path_key text not null check (path_key in ('HEAVENLY_DEMON', 'HUNTER')),
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (path_key, name)
);

create table if not exists public.workout_plan_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.workout_plans (id) on delete cascade,
  day_number integer not null check (day_number > 0),
  title text not null,
  template jsonb not null default '{}'::jsonb,
  unique (plan_id, day_number)
);

create table if not exists public.user_selected_workout_plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id uuid not null references public.workout_plans (id) on delete restrict,
  selected_at timestamptz not null default now()
);

create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_id uuid references public.workout_plans (id) on delete set null,
  log_date date not null,
  completed boolean not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

-- ------------------------------------------------------------------
-- Groups + leaderboard + challenges MVP
-- ------------------------------------------------------------------
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text not null,
  challenge_type text not null check (challenge_type in ('most_xp_week', 'complete_quests')),
  target_value integer not null default 0,
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.challenge_entries (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  progress_value integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

-- ------------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.quests enable row level security;
alter table public.user_active_quests enable row level security;
alter table public.quest_completions enable row level security;
alter table public.workout_plans enable row level security;
alter table public.workout_plan_days enable row level security;
alter table public.user_selected_workout_plans enable row level security;
alter table public.workout_logs enable row level security;
alter table public.xp_events enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_entries enable row level security;

DO $$
begin
  -- profiles
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_own') then
    create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_insert_own') then
    create policy profiles_insert_own on public.profiles for insert with check (auth.uid() = id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_update_own') then
    create policy profiles_update_own on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
  end if;

  -- quests definition public read
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quests' and policyname='quests_read_authenticated') then
    create policy quests_read_authenticated on public.quests for select using (auth.uid() is not null);
  end if;

  -- active quests
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_active_quests' and policyname='uaq_own_all') then
    create policy uaq_own_all on public.user_active_quests for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- completions
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='quest_completions' and policyname='qc_own_all') then
    create policy qc_own_all on public.quest_completions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- workout definitions public read
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workout_plans' and policyname='workout_plans_read_authenticated') then
    create policy workout_plans_read_authenticated on public.workout_plans for select using (auth.uid() is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workout_plan_days' and policyname='workout_plan_days_read_authenticated') then
    create policy workout_plan_days_read_authenticated on public.workout_plan_days for select using (auth.uid() is not null);
  end if;

  -- selected plans
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_selected_workout_plans' and policyname='selected_plan_own_all') then
    create policy selected_plan_own_all on public.user_selected_workout_plans for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- logs
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='workout_logs' and policyname='workout_logs_own_all') then
    create policy workout_logs_own_all on public.workout_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  -- xp events
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='xp_events' and policyname='xp_events_own_select') then
    create policy xp_events_own_select on public.xp_events for select using (auth.uid() = user_id);
  end if;

  -- groups
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='groups' and policyname='groups_member_select') then
    create policy groups_member_select
      on public.groups
      for select
      using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = groups.id and gm.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='groups' and policyname='groups_insert_owner') then
    create policy groups_insert_owner on public.groups for insert with check (auth.uid() = created_by);
  end if;

  -- group members
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='group_members' and policyname='group_members_same_group_select') then
    create policy group_members_same_group_select
      on public.group_members
      for select
      using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = group_members.group_id and gm.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='group_members' and policyname='group_members_insert_self') then
    create policy group_members_insert_self
      on public.group_members
      for insert
      with check (
        auth.uid() = user_id
        and exists (
          select 1 from public.groups g
          where g.id = group_members.group_id
        )
      );
  end if;

  -- challenges
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='challenges' and policyname='challenges_group_member_select') then
    create policy challenges_group_member_select
      on public.challenges
      for select
      using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = challenges.group_id and gm.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='challenges' and policyname='challenges_group_member_insert') then
    create policy challenges_group_member_insert
      on public.challenges
      for insert
      with check (
        auth.uid() = created_by
        and exists (
          select 1 from public.group_members gm
          where gm.group_id = challenges.group_id and gm.user_id = auth.uid()
        )
      );
  end if;

  -- challenge entries
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='challenge_entries' and policyname='challenge_entries_group_member_select') then
    create policy challenge_entries_group_member_select
      on public.challenge_entries
      for select
      using (
        exists (
          select 1
          from public.challenges c
          join public.group_members gm on gm.group_id = c.group_id
          where c.id = challenge_entries.challenge_id and gm.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='challenge_entries' and policyname='challenge_entries_user_insert') then
    create policy challenge_entries_user_insert
      on public.challenge_entries
      for insert
      with check (
        auth.uid() = user_id
        and exists (
          select 1
          from public.challenges c
          join public.group_members gm on gm.group_id = c.group_id
          where c.id = challenge_entries.challenge_id and gm.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='challenge_entries' and policyname='challenge_entries_user_update') then
    create policy challenge_entries_user_update
      on public.challenge_entries
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

-- ------------------------------------------------------------------
-- Helper for streak recomputation
-- ------------------------------------------------------------------
create or replace function public.recalculate_streaks(p_user_id uuid)
returns table (current_streak integer, longest_streak integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current integer := 0;
  v_longest integer := 0;
  v_date date := current_date;
begin
  while exists (
    select 1
    from public.workout_logs l
    where l.user_id = p_user_id
      and l.log_date = v_date
      and l.completed = true
  ) loop
    v_current := v_current + 1;
    v_date := v_date - 1;
  end loop;

  select coalesce(max(streak_len), 0)
  into v_longest
  from (
    select count(*) as streak_len
    from (
      select log_date,
             (log_date - row_number() over(order by log_date)::int) as grp
      from (
        select distinct log_date
        from public.workout_logs
        where user_id = p_user_id and completed = true
      ) d
    ) x
    group by grp
  ) streaks;

  update public.profiles p
  set
    current_streak = v_current,
    longest_streak = greatest(coalesce(p.longest_streak, 0), v_longest)
  where p.id = p_user_id;

  return query
  select v_current, v_longest;
end;
$$;

-- ------------------------------------------------------------------
-- Secure RPC: select quest
-- ------------------------------------------------------------------
create or replace function public.select_quest(p_quest_id uuid)
returns table (active_quest_id uuid, quest_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_path text;
  v_active_count integer;
  v_quest record;
  v_row public.user_active_quests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select path_key into v_path from public.profiles where id = v_user_id;
  if v_path is null then
    raise exception 'Select a path before selecting quests';
  end if;

  select * into v_quest
  from public.quests q
  where q.id = p_quest_id and q.is_active = true;

  if not found then
    raise exception 'Quest not found';
  end if;

  if v_quest.path_key <> v_path then
    raise exception 'Quest path mismatch';
  end if;

  select count(*) into v_active_count
  from public.user_active_quests aq
  where aq.user_id = v_user_id and aq.status = 'active';

  if v_active_count >= 3 then
    raise exception 'Active quest limit reached (3)';
  end if;

  insert into public.user_active_quests (user_id, quest_id, status)
  values (v_user_id, p_quest_id, 'active')
  on conflict do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.user_active_quests aq
    where aq.user_id = v_user_id
      and aq.quest_id = p_quest_id
      and aq.status = 'active'
    limit 1;
  end if;

  return query
  select v_row.id, v_row.quest_id, v_row.status;
end;
$$;

-- ------------------------------------------------------------------
-- Secure RPC: complete quest (idempotent XP)
-- ------------------------------------------------------------------
create or replace function public.complete_quest(
  p_active_quest_id uuid,
  p_optional_note text default null
)
returns table (awarded boolean, awarded_xp integer, total_xp integer, level integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_active record;
  v_completion_id uuid;
  v_total integer;
  v_xp integer;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select aq.id, aq.user_id, aq.quest_id, aq.status, q.xp_reward
  into v_active
  from public.user_active_quests aq
  join public.quests q on q.id = aq.quest_id
  where aq.id = p_active_quest_id
    and aq.user_id = v_user_id
  for update;

  if not found then
    raise exception 'Active quest not found';
  end if;

  if v_active.status <> 'active' then
    select p.total_xp into v_total from public.profiles p where p.id = v_user_id;
    return query select false, 0, coalesce(v_total, 0), (coalesce(v_total, 0) / 100) + 1;
    return;
  end if;

  insert into public.quest_completions (user_id, active_quest_id, quest_id, note)
  values (v_user_id, v_active.id, v_active.quest_id, p_optional_note)
  on conflict (active_quest_id) do nothing
  returning id into v_completion_id;

  if v_completion_id is null then
    select p.total_xp into v_total from public.profiles p where p.id = v_user_id;
    update public.user_active_quests
    set status = 'completed', completed_at = coalesce(completed_at, now()), note = coalesce(note, p_optional_note)
    where id = v_active.id;

    return query select false, 0, coalesce(v_total, 0), (coalesce(v_total, 0) / 100) + 1;
    return;
  end if;

  v_xp := v_active.xp_reward;

  insert into public.xp_events (user_id, source_type, source_id, amount)
  values (v_user_id, 'quest_completion', v_completion_id, v_xp)
  on conflict (user_id, source_type, source_id) do nothing;

  update public.user_active_quests
  set status = 'completed', completed_at = now(), note = coalesce(p_optional_note, note)
  where id = v_active.id;

  update public.profiles
  set total_xp = coalesce(total_xp, 0) + v_xp
  where id = v_user_id
  returning total_xp into v_total;

  return query
  select true, v_xp, coalesce(v_total, 0), (coalesce(v_total, 0) / 100) + 1;
end;
$$;

-- ------------------------------------------------------------------
-- Secure RPC: select workout plan
-- ------------------------------------------------------------------
create or replace function public.select_workout_plan(p_plan_id uuid)
returns table (plan_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_path text;
  v_plan_path text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select path_key into v_path from public.profiles where id = v_user_id;
  if v_path is null then
    raise exception 'Select a path before selecting workout plan';
  end if;

  select path_key into v_plan_path
  from public.workout_plans
  where id = p_plan_id and is_active = true;

  if not found then
    raise exception 'Workout plan not found';
  end if;

  if v_plan_path <> v_path then
    raise exception 'Workout plan path mismatch';
  end if;

  insert into public.user_selected_workout_plans (user_id, plan_id)
  values (v_user_id, p_plan_id)
  on conflict (user_id)
  do update set plan_id = excluded.plan_id, selected_at = now();

  return query select p_plan_id;
end;
$$;

-- ------------------------------------------------------------------
-- Secure RPC: log workout (idempotent XP)
-- ------------------------------------------------------------------
create or replace function public.log_workout(
  p_date date,
  p_completed boolean,
  p_optional_payload jsonb default '{}'::jsonb
)
returns table (
  log_id uuid,
  awarded_xp integer,
  current_streak integer,
  longest_streak integer,
  total_xp integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan_id uuid;
  v_log public.workout_logs%rowtype;
  v_event_id uuid;
  v_award integer := 0;
  v_total integer := 0;
  v_current integer := 0;
  v_longest integer := 0;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  select plan_id into v_plan_id
  from public.user_selected_workout_plans
  where user_id = v_user_id;

  insert into public.workout_logs (user_id, plan_id, log_date, completed, payload, updated_at)
  values (v_user_id, v_plan_id, p_date, p_completed, coalesce(p_optional_payload, '{}'::jsonb), now())
  on conflict (user_id, log_date)
  do update set
    completed = excluded.completed,
    payload = excluded.payload,
    plan_id = coalesce(excluded.plan_id, workout_logs.plan_id),
    updated_at = now()
  returning * into v_log;

  if v_log.completed = true then
    insert into public.xp_events (user_id, source_type, source_id, amount)
    values (v_user_id, 'workout_log', v_log.id, 20)
    on conflict (user_id, source_type, source_id) do nothing
    returning id into v_event_id;

    if v_event_id is not null then
      v_award := 20;
      update public.profiles
      set total_xp = coalesce(total_xp, 0) + v_award
      where id = v_user_id
      returning total_xp into v_total;
    else
      select total_xp into v_total from public.profiles where id = v_user_id;
    end if;
  else
    select total_xp into v_total from public.profiles where id = v_user_id;
  end if;

  select s.current_streak, s.longest_streak
  into v_current, v_longest
  from public.recalculate_streaks(v_user_id) s;

  return query
  select v_log.id, v_award, coalesce(v_current, 0), coalesce(v_longest, 0), coalesce(v_total, 0);
end;
$$;

-- ------------------------------------------------------------------
-- Secure RPC: group leaderboard
-- ------------------------------------------------------------------
create or replace function public.get_leaderboard(
  p_group_id uuid,
  p_timeframe text default 'weekly'
)
returns table (user_id uuid, username text, xp_total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_member boolean;
  v_cutoff timestamptz;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select exists(
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = v_user_id
  ) into v_is_member;

  if not v_is_member then
    raise exception 'You are not a member of this group';
  end if;

  if p_timeframe = 'weekly' then
    v_cutoff := date_trunc('week', now());
  else
    v_cutoff := '1970-01-01'::timestamptz;
  end if;

  return query
  select
    gm.user_id,
    p.username,
    coalesce(sum(x.amount), 0)::integer as xp_total
  from public.group_members gm
  left join public.profiles p on p.id = gm.user_id
  left join public.xp_events x
    on x.user_id = gm.user_id
    and x.created_at >= v_cutoff
  where gm.group_id = p_group_id
  group by gm.user_id, p.username
  order by xp_total desc, p.username asc;
end;
$$;

-- ------------------------------------------------------------------
-- Seed quests (mirrored path experiences)
-- ------------------------------------------------------------------
insert into public.quests (path_key, title, description, flavor_text, category, difficulty, xp_reward, is_active)
values
  ('HEAVENLY_DEMON', 'Abyss Focus Block', 'Complete one 50-minute deep study block with no distractions.', 'Steady breath. One blade, one target.', 'study', 'easy', 20, true),
  ('HEAVENLY_DEMON', 'Scripture Extraction', 'Summarize one chapter into actionable notes.', 'Distill chaos into doctrine.', 'study', 'med', 30, true),
  ('HEAVENLY_DEMON', 'Technique Refinement', 'Refactor one feature and remove dead code.', 'Polish the form until no waste remains.', 'coding', 'med', 35, true),
  ('HEAVENLY_DEMON', 'Demon Forge Delivery', 'Ship one meaningful feature PR end-to-end.', 'Power is useless if it cannot manifest.', 'coding', 'hard', 50, true),
  ('HEAVENLY_DEMON', 'Body Tempering', 'Log one gym session from your active plan.', 'The vessel must endure what the mind commands.', 'gym', 'easy', 20, true),
  ('HEAVENLY_DEMON', 'Market Dao Observation', 'Perform 30 minutes of market/competitor research.', 'Observe patterns before striking.', 'business', 'med', 30, true),
  ('HEAVENLY_DEMON', 'Customer Echo Trial', 'Run one customer discovery conversation.', 'Truth comes from direct contact.', 'business', 'hard', 45, true),

  ('HUNTER', 'Dungeon Study Run', 'Complete one 50-minute study sprint.', 'Clear one room at a time.', 'study', 'easy', 20, true),
  ('HUNTER', 'Raid Debrief Notes', 'Turn one learning resource into execution notes.', 'No mission succeeds without intel.', 'study', 'med', 30, true),
  ('HUNTER', 'Skill Tree Upgrade', 'Implement one focused coding practice task.', 'Every clean rep raises your rank.', 'coding', 'med', 35, true),
  ('HUNTER', 'Boss Feature Kill', 'Ship one production-ready feature.', 'Raid bosses fall to coordinated execution.', 'coding', 'hard', 50, true),
  ('HUNTER', 'Training Grounds Session', 'Log one workout from your selected plan.', 'A hunter with no stamina is a liability.', 'gym', 'easy', 20, true),
  ('HUNTER', 'Guild Market Scan', 'Run competitor analysis for one niche.', 'Scout the battlefield before committing.', 'business', 'med', 30, true),
  ('HUNTER', 'Quest Validation Mission', 'Run one customer validation experiment.', 'Confirm demand before scaling effort.', 'business', 'hard', 45, true)
on conflict (path_key, title) do update set
  description = excluded.description,
  flavor_text = excluded.flavor_text,
  category = excluded.category,
  difficulty = excluded.difficulty,
  xp_reward = excluded.xp_reward,
  is_active = excluded.is_active;

-- ------------------------------------------------------------------
-- Seed workout plans + day templates (3 per path)
-- ------------------------------------------------------------------
insert into public.workout_plans (path_key, name, description, is_active)
values
  ('HEAVENLY_DEMON', 'Push/Pull/Legs', 'Classic split for relentless discipline.', true),
  ('HEAVENLY_DEMON', 'Upper/Lower', 'Structured progression with recovery rhythm.', true),
  ('HEAVENLY_DEMON', 'Full Body Forge', 'Three full-body sessions focused on compound mastery.', true),
  ('HUNTER', 'Push/Pull/Legs', 'Raid-ready split for power and endurance.', true),
  ('HUNTER', 'Upper/Lower', 'Guild training cycle for strength and volume.', true),
  ('HUNTER', 'Full Body Ops', 'Flexible full-body protocol for busy hunter schedules.', true)
on conflict (path_key, name) do update set
  description = excluded.description,
  is_active = excluded.is_active;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Day 1', jsonb_build_object('focus', 'Push', 'exercises', jsonb_build_array('Bench 4x6', 'Overhead Press 3x8', 'Dips 3x10'))
from public.workout_plans p
where p.name = 'Push/Pull/Legs'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Day 2', jsonb_build_object('focus', 'Pull', 'exercises', jsonb_build_array('Row 4x8', 'Pull-up 4x6', 'Face Pull 3x15'))
from public.workout_plans p
where p.name = 'Push/Pull/Legs'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 3, 'Day 3', jsonb_build_object('focus', 'Legs', 'exercises', jsonb_build_array('Squat 4x6', 'RDL 3x8', 'Lunge 3x10'))
from public.workout_plans p
where p.name = 'Push/Pull/Legs'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Upper A', jsonb_build_object('focus', 'Upper', 'exercises', jsonb_build_array('Bench 4x6', 'Row 4x8', 'Lateral Raise 3x12'))
from public.workout_plans p
where p.name = 'Upper/Lower'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Lower A', jsonb_build_object('focus', 'Lower', 'exercises', jsonb_build_array('Squat 4x5', 'RDL 3x8', 'Calf Raise 3x15'))
from public.workout_plans p
where p.name = 'Upper/Lower'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 3, 'Upper B', jsonb_build_object('focus', 'Upper', 'exercises', jsonb_build_array('Incline Press 4x8', 'Pull-up 4x6', 'Triceps 3x12'))
from public.workout_plans p
where p.name = 'Upper/Lower'
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Full Body A', jsonb_build_object('focus', 'Full Body', 'exercises', jsonb_build_array('Squat 4x5', 'Bench 4x6', 'Row 4x8'))
from public.workout_plans p
where p.name in ('Full Body Forge', 'Full Body Ops')
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Full Body B', jsonb_build_object('focus', 'Full Body', 'exercises', jsonb_build_array('Deadlift 3x5', 'OHP 4x6', 'Pull-up 4x6'))
from public.workout_plans p
where p.name in ('Full Body Forge', 'Full Body Ops')
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 3, 'Full Body C', jsonb_build_object('focus', 'Full Body', 'exercises', jsonb_build_array('Front Squat 4x6', 'Incline Press 4x8', 'Row 4x10'))
from public.workout_plans p
where p.name in ('Full Body Forge', 'Full Body Ops')
on conflict (plan_id, day_number) do update set title = excluded.title, template = excluded.template;
