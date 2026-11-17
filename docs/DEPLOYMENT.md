# Deployment

**Status at time of writing:** this branch has **not** been deployed and **neither migration phase has been applied to production** (confirmed on 2026-11-17: production has no `accept_quest` RPC). Everything below was verified on a local Supabase stack (Postgres 17) and local builds, including the **pre-rescue frontend** running against each migration phase (`tests/compat/old-frontend-smoke.mjs`).

## Two-phase rollout

The database change is split so production is never left with a frontend and database that disagree:

| Phase | File | Safe with the **current** frontend? | When |
|---|---|---|---|
| **A** — additive + anon lockdown | `20261117000100_phase_a_additive_hardening.sql` | **Yes.** Proven by driving the old UI against it: sign-in, path choice, daily claim, quest accept/complete, guild join, leaderboard, workout all still work. | Any time, as soon as possible (it closes the anonymous-access holes) |
| **B** — cutover | `20261117000200_phase_b_cutover.sql` | **No.** The old UI breaks immediately (verified). | Minutes before the new frontend goes live |

Apply them in the **Supabase SQL editor** (paste the file, run). Each file is a single transaction and idempotent; if anything errors, nothing is applied.

### Stage 1: Phase A (now; no user impact)

1. Run `supabase/manual/01_preflight_audit.sql` (read-only) and keep the output.
2. Back up: Dashboard → Database → Backups.
3. Run `20261117000100_phase_a_additive_hardening.sql`.
4. Run `supabase/manual/03_post_apply_checks.sql`: every **A** row must be `true`. B rows are expected `false` until stage 2.
5. Use the live app normally for a few minutes (sign in, complete a quest). Nothing should change for users.

### Stage 2: Cutover (pick a low-traffic window, ~10 minutes)

1. Rerun `01_preflight_audit.sql`. Review the XP reconciliation preview (query 1) and confirm query 8 (duplicate active instances) is empty.
2. Back up again.
3. Run `20261117000200_phase_b_cutover.sql`.
4. Run `03_post_apply_checks.sql`: **all** rows must be `true`.
5. **Immediately** merge the PR (squash) so Vercel deploys the new frontend. Between steps 3 and 5 the old frontend shows errors to signed-in users, so keep this gap short.
6. Smoke test production with a normal account: sign in → accept a quest → complete it → XP rises by exactly the reward → Character and Guild agree → refresh → sign out and back in.
7. If anything fails, follow **Rollback** below.

### Stage 3: Security follow-up

Deactivate the leaked QA account (`supabase/manual/02_qa_account_remediation.sql`) and complete the other actions in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

### Migration history (only if you use the Supabase CLI)

The SQL-editor route doesn't touch `supabase_migrations.schema_migrations`. If you later adopt `supabase db push`, first mark what's already applied: `supabase migration repair --status applied 20260301000100 20260301000200 20261117000100 20261117000200` (the two `20260301_*` files were renamed to unique versions; the CLI rejects duplicate versions).

## Vercel

- Build: `npm run build` · Output: `dist` · Node 20+.
- Environment (Production and Preview):
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required)
  - `VITE_ENABLE_GOOGLE_AUTH=true` only after Google is enabled in Supabase
  - `VITE_DEMO_MODE=true` only for a demo deployment
  - **Never** add the service-role key or demo passwords to Vercel.
- `vercel.json`: SPA rewrite to `/index.html` (Vercel serves static files first, so assets are unaffected). Nested routes like `/guild` survive refresh. `sw.js`, `index.html` and the manifest are `max-age=0, must-revalidate`; `/assets/*` is immutable.
- **Preview deployments** of this PR built against the production database will show "The server is missing a required update" until the migration is applied. That message is intended.

## Supabase Auth settings

- Site URL: production origin.
- Redirect URLs: `https://<prod-domain>/auth/callback`, plus preview domains if used.
- The app uses PKCE with `detectSessionInUrl`, so email confirmation and OAuth links land on `/auth/callback` and are exchanged automatically.

## PWA update behavior

- `registerType: 'prompt'`: after a deploy, open clients show "A new version of ZBXP is available · Reload". Nothing reloads silently. Clients also check for a new service worker hourly.
- No runtime caching: API and auth requests always go to the network (verified by `tests/e2e/pwa.spec.js` against a production build).
- `cleanupOutdatedCaches` removes old precaches. The old hand-written `public/sw.js` (which only called skipWaiting/claim) was removed; the generated `sw.js` replaces it at the same URL, so existing installs upgrade normally.

## Rollback

**Frontend:** redeploy the previous Vercel deployment. The old frontend will **not** work against the migrated database, because direct XP writes and old RPCs are revoked. Roll back the database too, or temporarily re-grant (below).

**Database:** neither phase drops tables or user rows. Phase A needs no rollback (it is invisible to the old frontend). To undo Phase B and restore old-frontend behavior:

```sql
-- Re-allow old RPCs for the old frontend (temporary)
grant execute on function public.complete_quest(uuid) to authenticated;          -- live signature
grant execute on function public.select_quest(uuid), public.log_workout(date, boolean, jsonb),
  public.create_guild(text), public.join_guild_by_code(text), public.get_leaderboard(uuid, text) to authenticated;
-- Restore pre-migration balances if needed
update public.profiles p set xp_total = s.xp_total_before, total_xp = s.total_xp_before
from public.xp_reconciliation_snapshots s where s.user_id = p.id;
delete from public.xp_events where source_type = 'reconciliation';
drop trigger if exists profiles_xp_mirror on public.profiles;
```

Re-granting table write privileges re-opens the vulnerabilities in the audit, so a database rollback should be short-lived. Restoring from the step-2 backup is the clean option.

## Local verification commands

```bash
npm run db:start && npm run db:verify      # replay migration on legacy data, assert invariants
npm run test:integration                   # 32 DB/API tests
npm run test:e2e                           # 10 browser tests incl. PWA on a production build
OLD_APP_URL=… node tests/compat/old-frontend-smoke.mjs   # pre-rescue UI vs. current DB phase
```
