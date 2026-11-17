# Test Results

**Run date:** 2026-11-17 · **Branch:** `feat/zbxp-demo-rescue`
**Environment:** macOS, Node 24.13.1, local Supabase stack via `supabase` CLI 2.122.1 (Postgres 17.11, GoTrue, PostgREST in Docker), Chromium (Playwright 1.64.0).

> Everything below ran against a **local** database and a local build. Nothing was run against the production Supabase project, apart from the read-only schema probes described in SECURITY_AUDIT.md. Live integration is **unverified** until the migration is applied there.

## Summary

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | ✅ 0 errors, 0 warnings |
| Production build | `npm run build` | ✅ no warnings. Largest chunk 230 kB (React), down from a single 505 kB chunk |
| Unit tests | `npm test` | ✅ **24/24** |
| Migration replay on legacy data (both phases) | `npm run db:verify` | ✅ **20/20** assertions |
| Pre-rescue frontend vs. Phase A only | `tests/compat/old-frontend-smoke.mjs` | ✅ all flows that work on the untouched schema still work |
| Pre-rescue frontend vs. Phase A + B | same, `EXPECT=breaks` | ✅ breaks as designed (cutover) |
| DB/API integration | `npm run test:integration` | ✅ **32/32** |
| Browser E2E (incl. PWA on a production build) | `npm run test:e2e` | ✅ **10/10** |

## Baseline (before changes, `main` @ `fbaaf8f`)

- `npm run build`: passed with a warning (single 505.57 kB JS chunk).
- `npm run lint`: passed.
- No test script or tests existed.

## Migration verification (`scripts/verify-migration.sh`)

Resets the local DB to the last pre-rescue migration and loads `supabase/tests/legacy_state_fixture.sql` (split `xp_total`/`total_xp` balances, client-only XP, completed quests stuck in `active`, an open legacy guild).

**After Phase A only** (8 assertions): anon has no EXECUTE and no table access; the old frontend's profile writes and RPCs are still granted; `_award_xp` is not callable; no data changed; no ledger rows added; the legacy unique constraint is intact.

**After Phase A + B** (12 assertions):

1. every balance equals its ledger sum
2. `total_xp` mirrors `xp_total`
3. the RPC-plus-mirror user keeps their displayed 95 XP (not 75, not 170)
4. a consistent user is unchanged (40)
5. client-only XP is preserved (30)
6. reconciliation events are dated at profile creation (no weekly-board inflation)
7. a stuck legacy completion is marked `completed`
8. an open legacy quest stays `active`
9. `anon` can execute **zero** non-extension functions in `public`
10. `authenticated` has no UPDATE on `profiles.xp_total`
11. `authenticated` cannot SELECT `groups.invite_code`
12. rerunning both migrations adds no ledger rows (idempotent)

## Old-frontend compatibility (the two-phase rollout)

The pre-rescue frontend (`main` @ `fbaaf8f`) was run from a git worktree against the local stack and driven through every write path it uses: profile bootstrap (direct upsert), path choice (direct UPDATE), daily claim (direct XP UPDATE), quest accept (`select_quest`), quest complete (`complete_quest` + XP fallback), guild create (`create_guild`), join by code, leaderboard (`get_leaderboard`), workout (`log_workout`).

| Database state | Result |
|---|---|
| Pre-rescue schema (baseline) | 8/9 pass. **Guild create fails** with SQL 42702 (ambiguous `group_id` in the repo's `create_guild`): a pre-existing bug. |
| + Phase A | **Same 8/9**, 0 permission errors, so Phase A is safe to apply while the old frontend is live |
| + Phase A + B | Old frontend breaks from path choice onward (7 permission errors), which is why Phase B ships with the new frontend |

Production's `create_guild` may differ from the repo (its functions have drifted), so the baseline bug may or may not exist live.

## Integration tests (real Postgres + PostgREST + GoTrue, real user sessions)

**Quests & XP**
- accept → listed as active · selecting the same quest twice returns the same instance
- active limit enforced server-side under **8 concurrent accepts** (exactly 5 succeed)
- quests from the other path rejected
- complete awards exactly once; **retry after a lost response** awards nothing; note persisted
- **10 concurrent completions** → one award; profile == ledger
- another user cannot complete my quest (no information leak)
- completed quest cannot be re-accepted during its cooldown; re-completion is a no-op
- repeatable quests are separate instances with separate rewards
- abandoning frees a slot and can never award XP

**Access control**
- direct UPDATE of `xp_total` / `total_xp` / streak / `display_name` rejected
- direct INSERT into `xp_events`, `user_active_quests`, `quest_completions`, `workout_logs`, `focus_sessions` rejected
- legacy/internal RPCs (`_award_xp`, `select_quest`, `complete_quest`, `recalculate_streaks`, `get_leaderboard`, `log_workout`) not callable
- anon can't call the API or read profiles/groups
- users see only their own profile, ledger and quests
- identity validation (no emails as names, length, valid path)
- new accounts start un-onboarded with 0 XP
- a completion cannot link someone else's focus session

**Focus & workouts**
- server-timed start linked to a quest
- completing before real time has elapsed → `FOCUS_TOO_FAST` / `FOCUS_INCOMPLETE`
- completes after the planned time, awards once, retries are idempotent
- one running session per user (new start supersedes)
- 48 XP/day focus cap
- cancelled and foreign sessions cannot be completed
- workout XP once per day with bonuses, and streak tracking
- back-dated workouts outside the window rejected

**Guilds & auth**
- create → join by code (case-insensitive) → duplicate join is a no-op → member-only leaderboard with no user ids/emails; leaderboard XP equals each profile's XP
- private guilds hidden from the directory and table reads; joinable by code only
- direct membership inserts and role escalation rejected; bad and injection-style codes rejected
- ownership transfers when the owner leaves
- sign in → returning session restored from storage → refresh rotates the token → sign out revokes it (old refresh token rejected)
- wrong password rejected

## Browser E2E (Playwright, Chromium)

| Test | What it proves |
|---|---|
| Demo journey run 1 (Ship 1 Small Feature) | All 10 steps of the spec: entry, sign-in, character values == DB, accept, focus with **navigate away/back + reload accuracy (±2 s)**, the server-verified 1-minute session completes, quest completion with reward card and **rank-up**, XP delta == reward exactly, profile == ledger, dashboard/character/guild consistent, refresh persistence, sign-out/in persistence, **no console errors** |
| Demo journey run 2 (Bug Zero Hour) | The journey works a second time with no reset or manual fixes |
| Responsive | No horizontal overflow on 7 screens × 1440/1280/768/390/320; mobile "More" sheet navigation |
| Deep links | Hard refresh on nested routes; legacy URL redirects; 404 screen |
| Keyboard | Skip link is first on page load; keyboard-only navigation |
| Reduced motion | Animations disabled under `prefers-reduced-motion` |
| Loading / API error | Delayed profile shows a bounded splash; a simulated 500 shows an error with a working Retry |
| Auth edge cases | Bad password; returning session; OAuth/email callback error page; **expired/revoked session returns to sign-in** (no hang) |
| Heavenly Demon onboarding | New account → path choice → Demon theme applied (`data-path`), path vocabulary, empty states, accept a trial |
| PWA (production build via `vite preview`) | Service worker active; **no Supabase API/auth response served from or stored in the SW cache**; deep-link reload under SW control |

Screenshots from these runs are in [`docs/screenshots/`](screenshots/).

## Bugs found by the tests and fixed

1. **Every quest completion failed (SQL 42702):** `RETURNS TABLE` output names shadowed table columns. Fixed with `#variable_conflict use_column` on all such functions.
2. **Skip link unreachable on first Tab:** focus was moved to `<main>` on initial mount (and again under StrictMode). It now moves only on real navigations.
3. **Mobile sign-in below the fold at 320px:** marketing copy is hidden on narrow screens.
4. Seeded `auth.users` rows with NULL token columns break GoTrue (fixture fixed; production check added to the preflight audit).

## Not verified

- Production database migration (no privileged access; intentionally not applied automatically).
- Vercel: the PR's preview **build succeeded** (Vercel check passed), but the preview URL is behind Vercel Deployment Protection (HTTP 302 to login), so it was not browser-tested. It also points at the unmigrated production database, so signed-in screens will show the "missing a required update" notice until the migration is applied.
- Google OAuth (disabled in the live project; the button is hidden unless `VITE_ENABLE_GOOGLE_AUTH=true`).
- Real multi-device sync timing on physical phones (emulated viewports only).
- Firefox/WebKit (Chromium only).
