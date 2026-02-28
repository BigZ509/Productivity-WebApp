-- ============================================================
-- 20260222_core_gameplay.sql
-- Core gameplay foundation: Paths, Quests, Gym logs/streaks,
-- XP events (anti-cheat), Groups + Leaderboard, Secure RPC.
-- Safe to re-run (idempotent where possible).
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- PROFILES: path + XP + streak + username
-- Assumes public.profiles already exists (from earlier migration).
-- Adds missing columns safely.
-- ============================================================

alter table public.profiles
  add column if not exists username text,
  add column if not exists path text,
  add column if not exists xp_total integer not null default 0,
  add column if not exists current_streak integer not null default 0,
  add column if not exists longest_streak integer not null default 0,
  add column if not exists last_workout_date date;

-- Optional: constrain path values (lightweight)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_path_check'
  ) then
    alter table public.profiles
      add constraint profiles_path_check
      check (path is null or path in ('HEAVENLY_DEMON', 'HUNTER'));
  end if;
end
$$;

-- ============================================================
-- QUEST DEFINITIONS
-- ============================================================

create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  path text not null,
  category text not null default 'general',
  difficulty text not null default 'easy',
  xp_reward integer not null default 50,
  created_at timestamptz not null default now()
);

-- Ensure seeds can upsert safely
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quests_path_title_unique'
  ) then
    alter table public.quests
      add constraint quests_path_title_unique unique (path, title);
  end if;
end
$$;

-- ============================================================
-- USER QUEST STATE
-- ============================================================

create table if not exists public.user_active_quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quest_id uuid not null references public.quests(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, quest_id)
);

create table if not exists public.quest_completions (
  id uuid primary key default gen_random_uuid(),
  active_quest_id uuid not null unique references public.user_active_quests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  optional_note text,
  completed_at timestamptz not null default now()
);

-- ============================================================
-- WORKOUT PLANS + DAYS + USER SELECTION + LOGS
-- ============================================================

create table if not exists public.workout_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  path text,
  created_at timestamptz not null default now(),
  unique (name)
);

create table if not exists public.workout_plan_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.workout_plans(id) on delete cascade,
  day_number integer not null,
  title text not null,
  template jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (plan_id, day_number)
);

create table if not exists public.user_selected_workout_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id uuid not null references public.workout_plans(id) on delete cascade,
  selected_at timestamptz not null default now()
);

create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null,
  completed boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'workout_logs_set_updated_at'
  ) then
    create trigger workout_logs_set_updated_at
    before update on public.workout_logs
    for each row execute function public.set_updated_at();
  end if;
end
$$;

-- ============================================================
-- XP EVENTS (anti-cheat)
-- ============================================================

create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null,        -- 'quest' | 'workout' | etc.
  source_id uuid not null,          -- references the row id (active quest id, workout_log id, etc.)
  amount integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);

-- ============================================================
-- GROUPS + MEMBERSHIP + CHALLENGES (MVP)
-- ============================================================

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member', -- 'owner'/'member'
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Optional entries (MVP placeholder)
create table if not exists public.challenge_entries (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

-- ============================================================
-- RLS ENABLE
-- ============================================================

alter table public.profiles enable row level security;
alter table public.user_active_quests enable row level security;
alter table public.quest_completions enable row level security;
alter table public.user_selected_workout_plans enable row level security;
alter table public.workout_logs enable row level security;
alter table public.xp_events enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_entries enable row level security;

-- Definition tables can be readable by authenticated users
alter table public.quests enable row level security;
alter table public.workout_plans enable row level security;
alter table public.workout_plan_days enable row level security;

-- ============================================================
-- RLS POLICIES (minimal + sane MVP)
-- ============================================================

-- PROFILES: only self
do $$
begin
  if not exists (select 1 from pg_policies where policyname='profiles_select_own') then
    create policy profiles_select_own on public.profiles
      for select using (auth.uid() = id);
  end if;

  if not exists (select 1 from pg_policies where policyname='profiles_update_own') then
    create policy profiles_update_own on public.profiles
      for update using (auth.uid() = id)
      with check (auth.uid() = id);
  end if;

  if not exists (select 1 from pg_policies where policyname='profiles_insert_own') then
    create policy profiles_insert_own on public.profiles
      for insert with check (auth.uid() = id);
  end if;
end
$$;

-- QUEST DEFINITIONS: authenticated read
do $$
begin
  if not exists (select 1 from pg_policies where policyname='quests_select_auth') then
    create policy quests_select_auth on public.quests
      for select using (auth.role() = 'authenticated');
  end if;
end
$$;

-- ACTIVE QUESTS: only self
do $$
begin
  if not exists (select 1 from pg_policies where policyname='active_quests_select_own') then
    create policy active_quests_select_own on public.user_active_quests
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='active_quests_insert_own') then
    create policy active_quests_insert_own on public.user_active_quests
      for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='active_quests_delete_own') then
    create policy active_quests_delete_own on public.user_active_quests
      for delete using (auth.uid() = user_id);
  end if;
end
$$;

-- QUEST COMPLETIONS: only self
do $$
begin
  if not exists (select 1 from pg_policies where policyname='quest_completions_select_own') then
    create policy quest_completions_select_own on public.quest_completions
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='quest_completions_insert_own') then
    create policy quest_completions_insert_own on public.quest_completions
      for insert with check (auth.uid() = user_id);
  end if;
end
$$;

-- WORKOUT DEFINITIONS: authenticated read
do $$
begin
  if not exists (select 1 from pg_policies where policyname='workout_plans_select_auth') then
    create policy workout_plans_select_auth on public.workout_plans
      for select using (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname='workout_plan_days_select_auth') then
    create policy workout_plan_days_select_auth on public.workout_plan_days
      for select using (auth.role() = 'authenticated');
  end if;
end
$$;

-- USER SELECTED PLAN: only self
do $$
begin
  if not exists (select 1 from pg_policies where policyname='user_selected_plan_select_own') then
    create policy user_selected_plan_select_own on public.user_selected_workout_plans
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='user_selected_plan_upsert_own') then
    create policy user_selected_plan_upsert_own on public.user_selected_workout_plans
      for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='user_selected_plan_update_own') then
    create policy user_selected_plan_update_own on public.user_selected_workout_plans
      for update using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

-- WORKOUT LOGS: only self
do $$
begin
  if not exists (select 1 from pg_policies where policyname='workout_logs_select_own') then
    create policy workout_logs_select_own on public.workout_logs
      for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='workout_logs_insert_own') then
    create policy workout_logs_insert_own on public.workout_logs
      for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where policyname='workout_logs_update_own') then
    create policy workout_logs_update_own on public.workout_logs
      for update using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end
$$;

-- XP EVENTS: only self read
do $$
begin
  if not exists (select 1 from pg_policies where policyname='xp_events_select_own') then
    create policy xp_events_select_own on public.xp_events
      for select using (auth.uid() = user_id);
  end if;
end
$$;

-- GROUPS + MEMBERS:
-- user can see groups where they're a member
do $$
begin
  if not exists (select 1 from pg_policies where policyname='groups_select_member') then
    create policy groups_select_member on public.groups
      for select using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = groups.id and gm.user_id = auth.uid()
        )
      );
  end if;

  if not exists (select 1 from pg_policies where policyname='groups_insert_auth') then
    create policy groups_insert_auth on public.groups
      for insert with check (created_by = auth.uid());
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_policies where policyname='group_members_select_member') then
    create policy group_members_select_member on public.group_members
      for select using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = group_members.group_id and gm.user_id = auth.uid()
        )
      );
  end if;

  -- allow user to insert themselves into a group (MVP)
  if not exists (select 1 from pg_policies where policyname='group_members_insert_self') then
    create policy group_members_insert_self on public.group_members
      for insert with check (user_id = auth.uid());
  end if;
end
$$;

-- CHALLENGES visible to group members
do $$
begin
  if not exists (select 1 from pg_policies where policyname='challenges_select_member') then
    create policy challenges_select_member on public.challenges
      for select using (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = challenges.group_id and gm.user_id = auth.uid()
        )
      );
  end if;

  if not exists (select 1 from pg_policies where policyname='challenges_insert_member') then
    create policy challenges_insert_member on public.challenges
      for insert with check (
        created_by = auth.uid()
        and exists (
          select 1 from public.group_members gm
          where gm.group_id = challenges.group_id and gm.user_id = auth.uid()
        )
      );
  end if;
end
$$;

-- ============================================================
-- SECURE HELPERS
-- ============================================================

-- Recalculate current streak based on workout_logs (consecutive completed days up to today)
create or replace function public.recalculate_streaks(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := current_date;
  streak int := 0;
  longest int;
begin
  -- count consecutive days ending today where completed=true
  while exists (
    select 1 from public.workout_logs wl
    where wl.user_id = p_user_id and wl.log_date = d and wl.completed = true
  ) loop
    streak := streak + 1;
    d := d - interval '1 day';
  end loop;

  select coalesce(longest_streak, 0) into longest
  from public.profiles
  where id = p_user_id;

  update public.profiles
  set current_streak = streak,
      longest_streak = greatest(longest, streak)
  where id = p_user_id;
end;
$$;

-- ============================================================
-- RPC: select_quest (max 3 active, idempotent)
-- ============================================================

create or replace function public.select_quest(p_quest_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if (select count(*) from public.user_active_quests where user_id = auth.uid()) >= 3 then
    raise exception 'Active quest limit reached (max 3)';
  end if;

  insert into public.user_active_quests(user_id, quest_id)
  values (auth.uid(), p_quest_id)
  on conflict (user_id, quest_id) do nothing;
end;
$$;

-- ============================================================
-- RPC: complete_quest (awards XP once)
-- ============================================================

create or replace function public.complete_quest(p_active_quest_id uuid, p_optional_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  xp int;
  v_rows int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Ensure this active quest belongs to caller
  if not exists (
    select 1 from public.user_active_quests ua
    where ua.id = p_active_quest_id and ua.user_id = auth.uid()
  ) then
    raise exception 'Quest not found for user';
  end if;

  -- Record completion (idempotent)
  insert into public.quest_completions(active_quest_id, user_id, optional_note)
  values (p_active_quest_id, auth.uid(), p_optional_note)
  on conflict (active_quest_id) do nothing;

  select q.xp_reward into xp
  from public.user_active_quests ua
  join public.quests q on q.id = ua.quest_id
  where ua.id = p_active_quest_id;

  if xp is null then xp := 0; end if;

  -- Award XP once (idempotent)
  insert into public.xp_events(user_id, source_type, source_id, amount)
  values (auth.uid(), 'quest', p_active_quest_id, xp)
  on conflict do nothing;

  get diagnostics v_rows = row_count;

  -- Only increment xp_total if xp event actually inserted
  if v_rows > 0 and xp > 0 then
    update public.profiles
    set xp_total = xp_total + xp
    where id = auth.uid();
  end if;
end;
$$;

-- ============================================================
-- RPC: select_workout_plan (upsert)
-- ============================================================

create or replace function public.select_workout_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.user_selected_workout_plans(user_id, plan_id)
  values (auth.uid(), p_plan_id)
  on conflict (user_id) do update set plan_id = excluded.plan_id, selected_at = now();
end;
$$;

-- ============================================================
-- RPC: log_workout (idempotent XP + recalculates streaks)
-- ============================================================

create or replace function public.log_workout(
  p_date date,
  p_completed boolean,
  p_optional_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log_id uuid;
  v_rows int;
  v_xp int := 40;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workout_logs(user_id, log_date, completed, payload)
  values (auth.uid(), p_date, p_completed, p_optional_payload)
  on conflict (user_id, log_date)
  do update set completed = excluded.completed, payload = excluded.payload
  returning id into v_log_id;

  if p_completed then
    insert into public.xp_events(user_id, source_type, source_id, amount)
    values (auth.uid(), 'workout', v_log_id, v_xp)
    on conflict do nothing;

    get diagnostics v_rows = row_count;

    if v_rows > 0 then
      update public.profiles
      set xp_total = xp_total + v_xp,
          last_workout_date = p_date
      where id = auth.uid();
    end if;
  end if;

  perform public.recalculate_streaks(auth.uid());
end;
$$;

-- ============================================================
-- RPC: get_leaderboard (weekly or all_time)
-- Returns: user_id, username, xp_total, rank
-- ============================================================

create or replace function public.get_leaderboard(p_group_id uuid, p_timeframe text default 'weekly')
returns table(user_id uuid, username text, xp integer, rank integer)
language sql
security definer
set search_path = public
as $$
  with timeframe as (
    select case
      when p_timeframe = 'weekly' then date_trunc('week', now())
      else to_timestamp(0)
    end as start_ts
  ),
  members as (
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
  ),
  sums as (
    select
      x.user_id,
      sum(x.amount)::int as xp
    from public.xp_events x, timeframe t
    where x.user_id in (select user_id from members)
      and x.created_at >= t.start_ts
    group by x.user_id
  )
  select
    m.user_id,
    coalesce(p.username, 'player') as username,
    coalesce(s.xp, 0) as xp,
    dense_rank() over (order by coalesce(s.xp,0) desc) as rank
  from members m
  left join sums s on s.user_id = m.user_id
  left join public.profiles p on p.id = m.user_id
  order by xp desc, username asc;
$$;

-- ============================================================
-- SEED DATA: Quests (both paths)
-- ============================================================

insert into public.quests (title, description, path, category, difficulty, xp_reward)
values
-- Heavenly Demon (discipline / mastery)
('Deep Focus Study', 'Study distraction-free for 45 minutes', 'HEAVENLY_DEMON', 'study', 'easy', 40),
('Chain Rule Mastery', 'Do 10 calculus problems cleanly', 'HEAVENLY_DEMON', 'study', 'medium', 80),
('Code & Conquer', 'Solve 2 coding problems', 'HEAVENLY_DEMON', 'coding', 'medium', 80),
('Ship a Feature', 'Implement and push one meaningful feature', 'HEAVENLY_DEMON', 'coding', 'hard', 140),
('Idea Distillation', 'Write a 1-paragraph one-liner for a startup idea', 'HEAVENLY_DEMON', 'business', 'easy', 50),

-- Hunter (missions / raids / validation)
('Market Recon', 'Research one competitor and summarize', 'HUNTER', 'business', 'easy', 50),
('Validation Strike', 'Talk to one potential user (DM/call) and log takeaways', 'HUNTER', 'business', 'hard', 120),
('Dungeon Sprint', 'Do a 25-minute focused work sprint', 'HUNTER', 'study', 'easy', 35),
('Bug Hunt', 'Fix one bug and write what caused it', 'HUNTER', 'coding', 'medium', 90),
('Link Library', 'Save 3 research links and annotate each', 'HUNTER', 'business', 'medium', 85)
on conflict (path, title) do update
set
  description = excluded.description,
  category = excluded.category,
  difficulty = excluded.difficulty,
  xp_reward = excluded.xp_reward;

-- ============================================================
-- SEED DATA: Workout Plans + Days
-- ============================================================

insert into public.workout_plans (name, path)
values
('Full Body Forge', null),
('Upper Lower Split', null),
('Push Pull Legs', null)
on conflict (name) do update set path = excluded.path;

-- Full Body Forge days
insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Full Body A',
  jsonb_build_object('focus','Full Body','exercises', jsonb_build_array(
    'Squat 3x5', 'Bench 3x5', 'Row 3x8', 'Core 3 sets'
  ))
from public.workout_plans p
where p.name = 'Full Body Forge'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Full Body B',
  jsonb_build_object('focus','Full Body','exercises', jsonb_build_array(
    'Deadlift 3x5', 'Overhead Press 3x6', 'Pullups 3 sets', 'Core 3 sets'
  ))
from public.workout_plans p
where p.name = 'Full Body Forge'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 3, 'Full Body C',
  jsonb_build_object('focus','Full Body','exercises', jsonb_build_array(
    'Front Squat 4x6', 'Incline Press 4x8', 'Row 4x10'
  ))
from public.workout_plans p
where p.name = 'Full Body Forge'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

-- Upper Lower Split days
insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Upper A',
  jsonb_build_object('focus','Upper','exercises', jsonb_build_array(
    'Bench 4x6', 'Row 4x8', 'Shoulder Press 3x8', 'Curls 3x12'
  ))
from public.workout_plans p
where p.name = 'Upper Lower Split'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Lower A',
  jsonb_build_object('focus','Lower','exercises', jsonb_build_array(
    'Squat 4x5', 'RDL 3x8', 'Leg Press 3x10', 'Calves 4x12'
  ))
from public.workout_plans p
where p.name = 'Upper Lower Split'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

-- Push Pull Legs days
insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 1, 'Push',
  jsonb_build_object('focus','Push','exercises', jsonb_build_array(
    'Bench 4x6', 'Incline DB 3x10', 'Overhead Press 3x8', 'Triceps 3x12'
  ))
from public.workout_plans p
where p.name = 'Push Pull Legs'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 2, 'Pull',
  jsonb_build_object('focus','Pull','exercises', jsonb_build_array(
    'Pullups 4 sets', 'Row 4x8', 'Face Pull 3x15', 'Biceps 3x12'
  ))
from public.workout_plans p
where p.name = 'Push Pull Legs'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;

insert into public.workout_plan_days (plan_id, day_number, title, template)
select p.id, 3, 'Legs',
  jsonb_build_object('focus','Legs','exercises', jsonb_build_array(
    'Squat 4x5', 'Leg Curl 3x12', 'Leg Extension 3x12', 'Calves 4x12'
  ))
from public.workout_plans p
where p.name = 'Push Pull Legs'
on conflict (plan_id, day_number) do update set title=excluded.title, template=excluded.template;
