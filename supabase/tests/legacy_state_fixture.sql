-- Test-only fixture: reproduces the data shapes the pre-rescue app wrote,
-- so 20261117000100_integrity_and_security.sql can be verified against them.
-- Run ONLY against a local database BEFORE applying that migration.

alter table public.profiles add column if not exists total_xp integer not null default 0;
alter table public.profiles add column if not exists player_class text;

do $$
declare
  u_a uuid := '00000000-0000-4000-a000-00000000000a'; -- RPC XP + client mirror (total_xp > xp_total)
  u_b uuid := '00000000-0000-4000-a000-00000000000b'; -- consistent user
  u_c uuid := '00000000-0000-4000-a000-00000000000c'; -- profile with no ledger at all (daily claims only)
  q uuid;
  aq uuid;
begin
  -- GoTrue requires empty strings (not NULL) in the token columns.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    (u_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'legacy-a@zbxp.test', '', now(), now() - interval '30 days', now(), '{}', '{}', '', '', '', ''),
    (u_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'legacy-b@zbxp.test', '', now(), now() - interval '20 days', now(), '{}', '{}', '', '', '', ''),
    (u_c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'legacy-c@zbxp.test', '', now(), now() - interval '10 days', now(), '{}', '{}', '', '', '', '')
  on conflict (id) do nothing;

  insert into public.profiles (id, username, path, xp_total, total_xp, created_at)
  values
    (u_a, 'LegacyA', 'HUNTER', 75, 95, now() - interval '30 days'),
    (u_b, 'LegacyB', 'HUNTER', 40, 40, now() - interval '20 days'),
    (u_c, 'legacy-c@zbxp.test', 'HEAVENLY_DEMON', 0, 30, now() - interval '10 days')
  on conflict (id) do update
    set username = excluded.username, path = excluded.path, xp_total = excluded.xp_total,
        total_xp = excluded.total_xp, created_at = excluded.created_at;

  -- u_a: a quest completed via the old RPC (row left in status 'active')
  select id into q from public.quests where path = 'HUNTER' and title = 'Fix 2 Bugs';
  insert into public.user_active_quests (user_id, quest_id, status, selected_at)
  values (u_a, q, 'active', now() - interval '3 days')
  returning id into aq;
  insert into public.quest_completions (active_quest_id, user_id, optional_note, completed_at)
  values (aq, u_a, 'legacy note', now() - interval '3 days');
  insert into public.xp_events (user_id, source_type, source_id, amount, created_at)
  values (u_a, 'quest', aq, 35, now() - interval '3 days');

  -- u_a: a workout via log_workout (40 XP). Ledger = 75 = xp_total.
  insert into public.workout_logs (user_id, log_date, completed, payload)
  values (u_a, current_date - 2, true, '{}');
  insert into public.xp_events (user_id, source_type, source_id, amount, created_at)
  select u_a, 'workout', id, 40, now() - interval '2 days' from public.workout_logs where user_id = u_a and log_date = current_date - 2;

  -- u_a: a still-active, never-completed quest
  select id into q from public.quests where path = 'HUNTER' and title = 'Read 20 Pages + Notes';
  insert into public.user_active_quests (user_id, quest_id, status, selected_at)
  values (u_a, q, 'active', now() - interval '1 day');

  -- u_b: consistent workout
  insert into public.workout_logs (user_id, log_date, completed, payload)
  values (u_b, current_date - 1, true, '{}');
  insert into public.xp_events (user_id, source_type, source_id, amount, created_at)
  select u_b, 'workout', id, 40, now() - interval '1 day' from public.workout_logs where user_id = u_b and log_date = current_date - 1;

  -- Legacy guild with the old open policies
  insert into public.groups (id, name, created_by, invite_code)
  values ('00000000-0000-4000-b000-000000000001', 'Legacy Guild', u_a, 'LEGACY01')
  on conflict (id) do nothing;
  insert into public.group_members (group_id, user_id, role)
  values ('00000000-0000-4000-b000-000000000001', u_a, 'owner'),
         ('00000000-0000-4000-b000-000000000001', u_b, 'member')
  on conflict do nothing;
end $$;
