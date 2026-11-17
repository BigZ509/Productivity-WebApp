#!/usr/bin/env bash
# Replays the rescue migration against legacy-shaped data on the LOCAL
# Supabase stack and asserts the reconciliation invariants.
#   1. reset local DB to the last pre-rescue migration
#   2. load supabase/tests/legacy_state_fixture.sql
#   3. apply remaining migrations
#   4. assert: balances == ledger sums, no XP lost or double counted,
#      stuck quests completed, re-running the migration is a no-op.
# NEVER point this at a hosted project: it resets the database.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_CONTAINER="${DB_CONTAINER:-supabase_db_zbxp}"
PRE_RESCUE_VERSION="20260301000200"
psql_local() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At "$@"; }

echo "→ Resetting LOCAL database to $PRE_RESCUE_VERSION"
npx supabase db reset --local --version "$PRE_RESCUE_VERSION" >/dev/null 2>&1

echo "→ Loading legacy fixture"
psql_local -q < supabase/tests/legacy_state_fixture.sql

fail=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then echo "  ✓ $name"; else echo "  ✗ $name (expected '$expected', got '$actual')"; fail=1; fi
}

echo "→ Phase A only (must be safe while the old frontend is live)"
psql_local -q < supabase/migrations/20261117000100_phase_a_additive_hardening.sql >/dev/null 2>&1
check "A: anon has EXECUTE on no public function" "0" \
  "$(psql_local -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')")"
check "A: anon has no table access" "f" "$(psql_local -c "select has_table_privilege('anon', 'public.profiles', 'select')")"
check "A: old frontend can still write its profile" "t" "$(psql_local -c "select has_column_privilege('authenticated', 'public.profiles', 'total_xp', 'update')")"
check "A: old frontend RPCs still callable" "t" "$(psql_local -c "select has_function_privilege('authenticated', 'public.select_quest(uuid)', 'execute') and has_function_privilege('authenticated', 'public.get_leaderboard(uuid,text)', 'execute')")"
check "A: authenticated cannot call _award_xp" "f" "$(psql_local -c "select has_function_privilege('authenticated', 'public._award_xp(uuid,text,uuid,integer,text)', 'execute')")"
check "A: no data changed (LegacyA still 75 / 95)" "75|95" "$(psql_local -c "select xp_total || '|' || total_xp from profiles where username = 'LegacyA'")"
check "A: no ledger rows added" "3" "$(psql_local -c "select count(*) from xp_events")"
check "A: legacy unique (user_id, quest_id) still present" "1" \
  "$(psql_local -c "select count(*) from pg_constraint where conrelid = 'public.user_active_quests'::regclass and contype = 'u'")"

echo "→ Applying all rescue migrations (A recorded + B cutover)"
npx supabase migration up --local >/dev/null 2>&1

check "every balance equals its ledger sum" "t" \
  "$(psql_local -c "select bool_and(p.xp_total = coalesce((select sum(amount) from xp_events x where x.user_id = p.id), 0)) from profiles p")"
check "total_xp mirrors xp_total" "t" "$(psql_local -c "select bool_and(total_xp = xp_total) from profiles")"
check "LegacyA keeps displayed 95 XP (not 75, not 170)" "95" "$(psql_local -c "select xp_total from profiles where username = 'LegacyA'")"
check "LegacyB unchanged at 40" "40" "$(psql_local -c "select xp_total from profiles where username = 'LegacyB'")"
check "client-only XP preserved for LegacyC (30)" "30" "$(psql_local -c "select xp_total from profiles where id = '00000000-0000-4000-a000-00000000000c'")"
check "reconciliation events dated at profile creation" "t" \
  "$(psql_local -c "select bool_and(x.created_at = p.created_at) from xp_events x join profiles p on p.id = x.user_id where x.source_type = 'reconciliation'")"
check "stuck legacy completion marked completed" "completed" \
  "$(psql_local -c "select uaq.status from user_active_quests uaq join quests q on q.id = uaq.quest_id where q.title = 'Fix 2 Bugs' and uaq.user_id = '00000000-0000-4000-a000-00000000000a'")"
check "open legacy quest still active" "active" \
  "$(psql_local -c "select uaq.status from user_active_quests uaq join quests q on q.id = uaq.quest_id where q.title = 'Read 20 Pages + Notes' and uaq.user_id = '00000000-0000-4000-a000-00000000000a'")"
check "anon has EXECUTE on no public function" "0" \
  "$(psql_local -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')")"
check "authenticated cannot UPDATE profiles.xp_total" "f" "$(psql_local -c "select has_column_privilege('authenticated', 'public.profiles', 'xp_total', 'update')")"
check "authenticated cannot read groups.invite_code" "f" "$(psql_local -c "select has_column_privilege('authenticated', 'public.groups', 'invite_code', 'select')")"

before="$(psql_local -c "select count(*) || ':' || sum(amount) from xp_events")"
echo "→ Re-running both rescue migrations (idempotency)"
psql_local -q < supabase/migrations/20261117000100_phase_a_additive_hardening.sql >/dev/null 2>&1
psql_local -q < supabase/migrations/20261117000200_phase_b_cutover.sql >/dev/null 2>&1
after="$(psql_local -c "select count(*) || ':' || sum(amount) from xp_events")"
check "re-run adds no ledger rows" "$before" "$after"

if [[ $fail -ne 0 ]]; then echo "Migration verification FAILED"; exit 1; fi
echo "Migration verification passed"
