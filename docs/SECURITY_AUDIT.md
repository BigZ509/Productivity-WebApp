# Security Audit: ZBXP demo rescue (2026-11-17)

Scope: the repository at `fbaaf8f` (main), plus **read-only** probes of the live Supabase project using its public anon key. No service-role access was available or used, and no production data was read or modified.

## How the live database was inspected

The PostgREST OpenAPI endpoint requires the service-role key, so the live schema was probed without executing anything:
- `select=<column>&limit=0` on each table (column existence; RLS returns no rows to anon).
- RPC calls over **GET** (PostgREST runs these in a READ ONLY transaction) with probe parameters, which return a "Perhaps you meant…" signature hint.

### Live drift from the repository (confirmed)

| Finding | Evidence |
|---|---|
| `profiles` has **both** `total_xp` and `xp_total`, plus `player_class` | column probes |
| `profiles.is_qa` and `profiles.perks` **do not exist**, so migration `20260221` did not fully apply | 42703 errors |
| Live `complete_quest(p_quest_id)` exists; no local migration defines that signature | PGRST202 hint |
| Live `is_group_member(p_group_id, p_user_id)` exists; not in any migration | PGRST202 hint |
| Google OAuth is **disabled** in live Auth settings, but the old UI showed a Google button | `/auth/v1/settings` |
| Email confirmation is enabled (`mailer_autoconfirm: false`) | `/auth/v1/settings` |

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **Critical** | Migration `20260221` seeded `test@test.com` with a **fixed password committed to the repo** and full "perks"; it also reset the password on every run. The same credentials were hardcoded in `AuthScreen` ("Dev Login"). The repository is **public**, and the password remains in git history. | Seed and frontend credentials removed. History was **not** rewritten, so the credential must be treated as public: deactivating the account (see **Required owner actions**) is mandatory. |
| 2 | **Critical** | `profiles_update_own` allowed users to update **any column**: `xp_total`, `total_xp`, streaks, `is_qa`, `perks`. The frontend itself granted XP this way (daily claim, "persist fallback"). | All client INSERT/UPDATE/DELETE revoked on app tables. Identity changes go through `set_identity()` with validation. XP is written only by `_award_xp()`. |
| 3 | **High** | Every function was executable by **anon** (Postgres default PUBLIC grant). Live `recalculate_streaks(p_user_id)` (SECURITY DEFINER) was reachable anonymously and performs an UPDATE on any user id. `get_leaderboard` and `is_group_member` also answered anon. | EXECUTE revoked from PUBLIC and anon on every non-extension function in `public`; default privileges changed. Legacy and internal functions are revoked from `authenticated` too. |
| 4 | **High** | `get_leaderboard(p_group_id)` returned any guild's roster and XP to any caller, with no membership check. | Replaced by `guild_leaderboard()`, which is member-only and returns no user ids or emails. |
| 5 | **High** | `groups_select_auth using (true)` exposed **every invite code** to every user, making "invite-only" meaningless. `group_members_insert_self_open` let anyone insert themselves into any guild directly. | Column grant excludes `invite_code` (members get it via `guild_my_guilds()`); a private/public `visibility` flag; joins only through `guild_join_by_code` / `guild_join_public`. All policies on app tables were reset (live policies drifted, and permissive policies OR together). |
| 6 | **High** | Frontend fallbacks inserted `user_active_quests` rows directly, bypassing the active limit. Users could also insert `quest_completions` rows. | Direct writes revoked. The new RPCs enforce the limit with an advisory lock. |
| 7 | Medium | `log_workout` accepted **any date**, so XP could be farmed by logging past days. | `record_workout` accepts today ±1 and the previous 2 days only; the payload is sanitized and size-capped. |
| 8 | Medium | Re-selecting a completed quest re-activated the **same row**, and completion never left `active`, so the UI kept offering "Complete" with no reward. | Instance-per-acceptance model with cooldowns; completion sets `status='completed'`. |
| 9 | Medium | Supabase auth lock replaced with a **no-op**, so concurrent tabs could race token refreshes. Root cause: awaiting queries inside `onAuthStateChange`. | Default lock restored; the callback is now synchronous. |
| 10 | Medium | Boss fight, guild XP, raid boss, guild quests and "chat" were **local-only state presented as live features**. | Removed from the product; boss and AI routes redirect to the dashboard. |
| 11 | Low | The old leaderboard fallback read other users' `profiles` rows (only possible if a broad select policy existed live). | Profiles are own-row only; names come from the SECURITY DEFINER leaderboard. |
| 12 | Low | Hand-written `auth.users` inserts (the removed seed) leave NULL token columns, which makes GoTrue fail with "Database error finding users". | The preflight audit query detects these; the remediation script repairs them. |
| 13 | Info | `.env` (anon key) is git-ignored and not in history: `git log --all -- .env` is empty. The anon key is public by design. | No action. |

All SECURITY DEFINER functions added by the migration use `set search_path = ''` and schema-qualified names, validate input lengths and formats, and raise errors with stable `hint` codes.

## Required owner actions (cannot be done from this branch)

1. **Run `supabase/manual/01_preflight_audit.sql`** (read-only) in the production SQL editor. Review the reconciliation preview and the list of `@test.com` accounts.
2. **Deactivate the leaked QA account** if it exists (it may have been created by the old migration or the old in-app "Dev Login" button, which signed up `test@test.com` with the same password). Use `supabase/manual/02_qa_account_remediation.sql`: ban it and revoke its sessions, or delete it. Treat the old password as public.
3. If any real account reused that password, force a password reset.
4. Apply **Phase A** (`20261117000100_phase_a_additive_hardening.sql`) now: it closes findings #3 (anonymous EXECUTE, including `recalculate_streaks`) and anonymous table access without affecting the live frontend. Apply **Phase B** at the cutover to close the rest. See [DEPLOYMENT.md](DEPLOYMENT.md).
5. Keep Google OAuth disabled until it is configured, then set `VITE_ENABLE_GOOGLE_AUTH=true` and add `https://<domain>/auth/callback` to Auth → Redirect URLs.
6. Provision demo access only on a **separate QA project** with `node scripts/demo-seed.mjs --reset --remote` (with `DEMO_ALLOW_REMOTE=yes`) and credentials from a secret store.

## Residual risks and notes

- Quest completion is self-reported (honor system). Cooldowns and the active limit cap the XP rate; the focus timer is server-verified.
- Users can belong to multiple guilds (up to 3 owned). There is no rate limit on invite-code guessing; codes are 8 hex characters (~4.3 billion combinations).
- `challenges` / `challenge_entries` tables still exist with their old policies, and anon is revoked. They are not used by the app.
- `src/assets/characters/*` and `src/assets/login/*` are unused images that appear to be third-party anime art. They are not bundled; consider removing them from the repo.
