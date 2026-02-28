-- ============================================================
-- 20260227_beta_v0_patch.sql
-- v0 beta patch: schema alignment, guild RPCs, seed quests,
-- and 5-day fat-loss push/pull workout plans.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Schema alignment for current frontend
-- ------------------------------------------------------------

alter table public.quests
  add column if not exists is_active boolean not null default true,
  add column if not exists flavor_text text;

alter table public.workout_plans
  add column if not exists description text not null default '',
  add column if not exists is_active boolean not null default true;

alter table public.user_active_quests
  add column if not exists selected_at timestamptz not null default now(),
  add column if not exists status text not null default 'active';

update public.user_active_quests
set selected_at = created_at
where selected_at is null;

update public.user_active_quests
set status = 'active'
where status is null;

alter table public.quest_completions
  add column if not exists note text;

update public.quest_completions
set note = optional_note
where note is null and optional_note is not null;

-- ------------------------------------------------------------
-- Guild invite codes + RPCs
-- ------------------------------------------------------------

alter table public.groups
  add column if not exists invite_code text;

update public.groups
set invite_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
where invite_code is null;

create unique index if not exists groups_invite_code_unique
  on public.groups(invite_code);

create or replace function public.create_guild(p_name text)
returns table(group_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_name is null or length(trim(p_name)) < 3 then
    raise exception 'Guild name must be at least 3 characters';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.groups(name, created_by, invite_code)
  values (trim(p_name), auth.uid(), v_code)
  returning id into v_group_id;

  insert into public.group_members(group_id, user_id, role)
  values (v_group_id, auth.uid(), 'owner')
  on conflict (group_id, user_id) do nothing;

  return query select v_group_id, v_code;
end;
$$;

create or replace function public.join_guild_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select g.id
  into v_group_id
  from public.groups g
  where g.invite_code = upper(trim(p_code));

  if v_group_id is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.group_members(group_id, user_id, role)
  values (v_group_id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

grant execute on function public.create_guild(text) to authenticated;
grant execute on function public.join_guild_by_code(text) to authenticated;

-- ------------------------------------------------------------
-- Productivity + performance quests seed (both paths)
-- ------------------------------------------------------------

insert into public.quests (title, description, path, category, difficulty, xp_reward, is_active, flavor_text)
values
  ('Deep Work Sprint (90m)', 'One uninterrupted focus block with no social media.', 'HUNTER', 'coding', 'medium', 35, true, 'Lock in and ship real output.'),
  ('Feature Shipped', 'Commit and ship one user-facing improvement.', 'HUNTER', 'coding', 'hard', 50, true, 'No overthinking. Publish.'),
  ('Bug Zero Hour', 'Close at least 3 actionable bugs or TODOs.', 'HUNTER', 'coding', 'medium', 30, true, 'Clean code compounds speed.'),
  ('Sales Outreach Block', 'Reach out to 10 qualified prospects.', 'HUNTER', 'business', 'hard', 45, true, 'Pipeline wins the week.'),
  ('Follow-up Power Hour', 'Send 15 follow-ups to warm leads.', 'HUNTER', 'business', 'medium', 30, true, 'Fortune follows follow-up.'),
  ('Content Engine', 'Publish one short-form post and one long-form post.', 'HUNTER', 'business', 'medium', 35, true, 'Document the journey publicly.'),
  ('Study Session 2h', 'Two hours of high-retention study with notes.', 'HUNTER', 'study', 'medium', 30, true, 'Knowledge is a weapon.'),
  ('Read 30 Pages', 'Read and summarize key lessons in 5 bullets.', 'HUNTER', 'study', 'easy', 18, true, 'Stack mental models daily.'),
  ('Workout Complete', 'Finish scheduled workout + cardio finisher.', 'HUNTER', 'gym', 'medium', 35, true, 'Body supports mission execution.'),
  ('Cardio Compliance', '20+ minutes zone 2 cardio.', 'HUNTER', 'gym', 'easy', 20, true, 'Conditioning improves every system.'),
  ('Daily Reflection', 'Journal wins, misses, and next action.', 'HUNTER', 'study', 'easy', 12, true, 'Feedback loop tightens performance.'),

  ('Shadow Focus Block (120m)', 'Two-hour blackout focus period.', 'HEAVENLY_DEMON', 'coding', 'hard', 55, true, 'Enter the void and execute.'),
  ('High-Risk Feature Push', 'Ship a difficult feature with tests.', 'HEAVENLY_DEMON', 'coding', 'hard', 60, true, 'Pressure reveals capability.'),
  ('Revenue Hunt', 'Book 3 sales calls in one day.', 'HEAVENLY_DEMON', 'business', 'hard', 55, true, 'Hunt aggressively.'),
  ('Offer Optimization', 'Improve offer page copy and CTA.', 'HEAVENLY_DEMON', 'business', 'medium', 35, true, 'Sharper positioning, higher conversion.'),
  ('Tactical Study (90m)', 'Study one domain deeply and apply immediately.', 'HEAVENLY_DEMON', 'study', 'medium', 32, true, 'Learn, then deploy.'),
  ('Memory Vault', 'Create 20 active-recall flashcards.', 'HEAVENLY_DEMON', 'study', 'easy', 16, true, 'Recall speed matters.'),
  ('Strength Session', 'Complete programmed strength workout.', 'HEAVENLY_DEMON', 'gym', 'medium', 38, true, 'Warrior body protocol.'),
  ('Conditioning Finisher', '15-minute interval finisher.', 'HEAVENLY_DEMON', 'gym', 'medium', 22, true, 'Finish strong.'),
  ('Night Audit', 'End-of-day tactical review + tomorrow plan.', 'HEAVENLY_DEMON', 'business', 'easy', 14, true, 'Close loops before sleep.')
on conflict (path, title) do update
set description = excluded.description,
    category = excluded.category,
    difficulty = excluded.difficulty,
    xp_reward = excluded.xp_reward,
    is_active = excluded.is_active,
    flavor_text = excluded.flavor_text;

-- ------------------------------------------------------------
-- 5-day fat-loss push/pull plan seed (both paths)
-- ------------------------------------------------------------

insert into public.workout_plans(name, path, description, is_active)
values
  ('HUNTER CUT PHASE PPL 5D', 'HUNTER', '5-day push/pull fat-loss split with daily conditioning.', true),
  ('DEMON CUT PHASE PPL 5D', 'HEAVENLY_DEMON', '5-day aggressive push/pull fat-loss split with cardio finishers.', true)
on conflict (name) do update
set path = excluded.path,
    description = excluded.description,
    is_active = excluded.is_active;

-- HUNTER plan days
insert into public.workout_plan_days(plan_id, day_number, title, template)
select p.id, d.day_number, d.title, d.template
from public.workout_plans p
cross join (
  values
    (1, 'PUSH A', '{"focus":"chest/shoulders/triceps + incline walk","cardio":"20m zone2","work":["Incline DB Press 4x8-10","Machine Shoulder Press 4x10","Cable Fly 3x12-15","Lateral Raise 4x15","Triceps Pressdown 4x12"]}'::jsonb),
    (2, 'PULL A', '{"focus":"back/biceps + intervals","cardio":"10x(30s hard/60s easy)","work":["Lat Pulldown 4x10","Chest Supported Row 4x10","Single Arm Row 3x12","Face Pull 3x15","EZ Curl 4x10"]}'::jsonb),
    (3, 'LEGS + CORE', '{"focus":"lower body + abs","cardio":"15m incline walk","work":["Back Squat 4x6-8","Romanian Deadlift 4x8","Walking Lunge 3x12 each","Leg Curl 3x12","Hanging Knee Raise 3x15"]}'::jsonb),
    (4, 'PUSH B', '{"focus":"upper push hypertrophy","cardio":"20m bike","work":["Flat DB Press 4x10","Arnold Press 4x10","Dip/Assisted Dip 3xAMRAP","Cable Lateral 4x15","Overhead Triceps Ext 3x12"]}'::jsonb),
    (5, 'PULL B', '{"focus":"posterior chain + arms","cardio":"12m rower intervals","work":["Deadlift 4x5","Seated Cable Row 4x10","Pull-up/Assisted 3xAMRAP","Rear Delt Fly 3x15","Hammer Curl 4x12"]}'::jsonb)
) as d(day_number, title, template)
where p.name = 'HUNTER CUT PHASE PPL 5D'
on conflict (plan_id, day_number) do update
set title = excluded.title,
    template = excluded.template;

-- DEMON plan days
insert into public.workout_plan_days(plan_id, day_number, title, template)
select p.id, d.day_number, d.title, d.template
from public.workout_plans p
cross join (
  values
    (1, 'PUSH A (DEMON)', '{"focus":"heavy push","cardio":"25m zone2","work":["Barbell Bench 5x5","Overhead Press 4x6","Incline DB Press 4x8","Lateral Raise 5x15","Skull Crushers 4x10"]}'::jsonb),
    (2, 'PULL A (DEMON)', '{"focus":"heavy pull","cardio":"12 rounds assault bike","work":["Weighted Pull-up 5x5","Barbell Row 5x6","Lat Pulldown 4x10","Face Pull 4x15","Barbell Curl 4x10"]}'::jsonb),
    (3, 'LEGS + CONDITIONING', '{"focus":"legs + engine","cardio":"sled pushes 10 rounds","work":["Front Squat 5x5","RDL 4x8","Bulgarian Split Squat 4x10","Leg Curl 4x12","Ab Wheel 4x12"]}'::jsonb),
    (4, 'PUSH B (DEMON)', '{"focus":"volume push","cardio":"20m incline treadmill","work":["DB Bench 4x10","Seated DB OHP 4x10","Cable Fly 4x15","Lateral Raise 5x15","Triceps Rope 4x12"]}'::jsonb),
    (5, 'PULL B (DEMON)', '{"focus":"volume pull","cardio":"15m intervals","work":["Romanian Deadlift 4x8","Seated Row 4x10","Pullover 4x12","Rear Delt Fly 4x15","Hammer Curl 4x12"]}'::jsonb)
) as d(day_number, title, template)
where p.name = 'DEMON CUT PHASE PPL 5D'
on conflict (plan_id, day_number) do update
set title = excluded.title,
    template = excluded.template;
