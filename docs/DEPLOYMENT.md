# Deployment

**Status at time of writing:** this branch has **not** been deployed and the migration has **not** been applied to production. Everything below was verified on a local Supabase stack (Postgres 17) and a local production build.

## Order of operations

The new frontend calls new RPCs, and the migration revokes the old RPCs and direct writes the current production frontend relies on. Deploy **database first, then frontend immediately after**:

1. **Preflight (read-only):** run `supabase/manual/01_preflight_audit.sql` in the production SQL editor. Check:
   - reconciliation deltas look reasonable (large deltas are users whose old client wrote XP outside the ledger);
   - query 8 returns no duplicate active instances (expected: none, since the old schema allowed one row per user+quest).
2. **Back up:** Dashboard → Database → Backups (or `pg_dump`) immediately before.
3. **Apply the migration** `supabase/migrations/20261117000100_integrity_and_security.sql`
   - via CLI: `supabase link --project-ref <ref>` then `supabase db push`, **or**
   - via the SQL editor: paste and run the file. It is a single transaction and idempotent.
   - Note: the two `20260301_*` migrations were renamed to unique versions (`20260301000100`, `20260301000200`). If production's `supabase_migrations.schema_migrations` already records `20260301`, run `supabase migration repair --status applied 20260301000100 20260301000200` before `db push`, or simply use the SQL editor.
4. **Deploy the frontend** (merge the PR; Vercel builds `main`).
5. **Smoke test** with a non-privileged account: sign in → accept → complete → check XP → guild.
6. **Owner security actions** from [SECURITY_AUDIT.md](SECURITY_AUDIT.md) (QA account).

During the minutes between steps 3 and 4, users on the old frontend will see errors when completing quests (the old RPCs are revoked). Prefer a low-traffic window.

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

**Database:** the migration is additive (no tables or user rows dropped). To restore the old behavior:

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
```
