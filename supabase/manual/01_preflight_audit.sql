-- =====================================================================
-- ZBXP pre-migration audit (READ ONLY). Run in the Supabase SQL editor
-- against production BEFORE applying 20261117000100. Nothing is changed.
-- =====================================================================

-- 1. XP reconciliation preview: what each profile's canonical XP will be.
--    canonical = greatest(xp_total, total_xp, ledger_sum); the gap is booked
--    once as a 'reconciliation' ledger event. Review large deltas.
with ledger as (
  select user_id, coalesce(sum(amount), 0)::int as total
  from public.xp_events group by user_id
)
select p.id,
       coalesce(p.display_name, p.username) as name,
       p.xp_total,
       p.total_xp,
       coalesce(l.total, 0) as ledger_sum,
       greatest(coalesce(p.xp_total, 0), coalesce(p.total_xp, 0), coalesce(l.total, 0)) as canonical_xp,
       greatest(coalesce(p.xp_total, 0), coalesce(p.total_xp, 0), coalesce(l.total, 0)) - coalesce(l.total, 0) as reconciliation_delta
from public.profiles p
left join ledger l on l.user_id = p.id
order by reconciliation_delta desc;

-- 2. Totals summary.
with ledger as (select user_id, sum(amount)::int total from public.xp_events group by user_id)
select count(*) as profiles,
       count(*) filter (where coalesce(p.total_xp, 0) <> coalesce(p.xp_total, 0)) as split_balances,
       count(*) filter (where coalesce(l.total, 0) <> greatest(coalesce(p.xp_total, 0), coalesce(p.total_xp, 0))) as ledger_mismatch
from public.profiles p left join ledger l on l.user_id = p.id;

-- 3. Quest rows that will be moved to 'completed' (old RPC never did).
select count(*) as stuck_completed_instances
from public.user_active_quests uaq
join public.quest_completions qc on qc.active_quest_id = uaq.id
where uaq.status is distinct from 'completed';

-- 4. QA / test accounts created by the removed seed migration or the old
--    in-app "Dev Login" button (fixed public password). See SECURITY_AUDIT.md.
select u.id, u.email, u.created_at, u.last_sign_in_at, u.banned_until
from auth.users u
where u.email in ('test@test.com')
   or u.email ilike '%@test.com';

-- 5. auth.users rows with NULL token columns (written by hand-made SQL
--    seeds). GoTrue fails "Database error finding users" on these.
select count(*) as users_with_null_tokens
from auth.users
where confirmation_token is null or recovery_token is null
   or email_change_token_new is null or email_change is null;

-- 6. Functions in public that anon can currently execute (expect many before
--    the migration, zero after).
select p.oid::regprocedure as function
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by 1;

-- 7. Every policy on app tables (the migration replaces these).
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 8. Duplicate active instances that would violate the new partial unique
--    index (should be zero; the old schema allowed one row per user+quest).
select user_id, quest_id, count(*)
from public.user_active_quests
where status = 'active'
group by 1, 2 having count(*) > 1;
