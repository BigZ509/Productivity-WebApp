-- =====================================================================
-- Post-apply checks (READ ONLY). Run after each phase in the SQL editor.
-- Every row should show ok = true for the phase you have applied.
-- =====================================================================

with checks(phase, name, ok) as (
  values
  -- Phase A ---------------------------------------------------------
  ('A', 'new RPCs exist',
     (select count(*) = 16 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'ensure_profile','set_identity','accept_quest','complete_active_quest','abandon_active_quest',
        'record_workout','start_focus_session','complete_focus_session','cancel_focus_session',
        'guild_create','guild_join_by_code','guild_join_public','guild_leave','guild_my_guilds',
        'guild_list_public','guild_leaderboard'))),
  ('A', 'focus_sessions table exists', to_regclass('public.focus_sessions') is not null),
  ('A', 'anon can execute no public function',
     (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))),
  ('A', 'anon cannot read profiles', not has_table_privilege('anon', 'public.profiles', 'select')),
  ('A', '_award_xp not callable by users',
     not has_function_privilege('authenticated', 'public._award_xp(uuid,text,uuid,integer,text)', 'execute')),
  -- Phase B ---------------------------------------------------------
  ('B', 'every balance equals its ledger sum',
     (select bool_and(p.xp_total = coalesce((select sum(amount) from public.xp_events x where x.user_id = p.id), 0))
      from public.profiles p)),
  ('B', 'total_xp mirrors xp_total', (select bool_and(total_xp = xp_total) from public.profiles)),
  ('B', 'users cannot update xp_total',
     not has_column_privilege('authenticated', 'public.profiles', 'xp_total', 'update')),
  ('B', 'invite codes hidden from users',
     not has_column_privilege('authenticated', 'public.groups', 'invite_code', 'select')),
  ('B', 'legacy get_leaderboard revoked',
     not exists (select 1 from pg_proc p where p.proname = 'get_leaderboard'
                 and has_function_privilege('authenticated', p.oid, 'execute'))),
  ('B', 'no quest instance in an unknown status',
     (select count(*) = 0 from public.user_active_quests where status not in ('active','completed','abandoned'))),
  ('B', 'reconciliation snapshot taken', to_regclass('public.xp_reconciliation_snapshots') is not null)
)
select phase, name, ok from checks order by phase, name;
