# Architecture

## Overview

```
Browser (React SPA, PWA shell)
  └─ services/*  ──supabase-js──►  PostgREST ──► Postgres
                                   (RPC: SECURITY DEFINER functions, RLS for reads)
                 ──supabase-js──►  GoTrue (Auth, PKCE)
```

Reads of a user's own rows go through RLS-protected table selects. **Every write goes through a validated RPC.** Client roles have no INSERT/UPDATE/DELETE on any app table.

## Frontend layout

```
src/
  main.jsx                 entry: fonts, styles, router
  app/
    App.jsx                provider tree + auth gate + routes (lazy pages)
    AppShell.jsx           sidebar (desktop) / top bar + bottom nav (mobile)
    UpdatePrompt.jsx       PWA "new version" prompt
    useThemePath.js        sets <html data-path> for Hunter/Demon theming
    providers/
      AuthProvider         session state; synchronous onAuthStateChange
      ProfileProvider      ensure_profile(); keyed on user id
      PlayerDataProvider   shared slices: active quests, XP ledger (60d), guilds
      RewardProvider       reward card (XP / level / rank up) + toasts
      contexts.js          contexts + hooks
  features/
    auth/                  AuthScreen, AuthCallback, Onboarding (path + name)
    dashboard/             CommandCenter
    quests/                QuestBoard, useQuestActions (accept/complete/abandon)
    focus/                 focusEngine (pure), FocusProvider (persisted), FocusChamber
    character/             CharacterPage, milestones (pure)
    guild/                 GuildHall
    gym/                   TrainingGrounds
    lab/                   Lab (device-local notebooks), useDeviceStore
  services/                all Supabase calls: profile, quests, activity, focus, guilds, workouts
  lib/                     supabaseClient, progression (level/rank rules), errors, dates, cx
  components/              ui primitives (Panel, Meter, RankEmblem, Notice…), WeekBars
  config/pathConfig.js     path identity + vocabulary (one architecture, two skins)
  styles/                  tokens → base → layout → components → features
```

Rules:
- Pages never call Supabase directly; they use `services/*`, which throw a normalized `AppError` (`lib/errors.js`) that carries the server's stable `hint` code.
- Business rules shared by several screens live in pure modules with unit tests: `progression.js`, `focusEngine.js`, `activity.js` (aggregations), `milestones.js`.
- Route URLs from the old build are preserved or redirected (`/skills`, `/stats` → `/character`; `/leaderboard` → `/guild`; `/tools` → `/lab`; `/boss`, `/ai` → `/dashboard`).

### Boot sequence

1. `AuthProvider` subscribes to `onAuthStateChange`. The callback is **synchronous** and only stores the session. (Awaiting Supabase calls inside it deadlocks the auth lock; that was the root cause behind the old no-op lock override, which has been removed.) A 10-second safety timeout falls back to the sign-in screen, so the splash can never spin forever.
2. `ProfileProvider` reacts to the user id (not the token), so token refreshes don't refetch. It calls `ensure_profile()` with a 12-second timeout and shows a retry/sign-out screen on failure.
3. No path chosen yet → `Onboarding`. Otherwise `PlayerDataProvider` + `FocusProvider` + `AppShell`.

### Theming

`tokens.css` defines one token set. `[data-path='HEAVENLY_DEMON']` swaps the accent family (#FF655B), background motif (ember haze instead of a grid), corner geometry (rounded and pill-shaped instead of chamfered) and motion timing. Components and pages are identical for both paths; vocabulary comes from `pathConfig.js` (for example, Quest/Trial and Focus Chamber/Meditation Chamber). Gold (#E8B95D) is reserved for rewards. `prefers-reduced-motion` disables all animation.

## Data model

| Table | Purpose |
|---|---|
| `profiles` | identity (display name, path), `xp_total` (canonical balance, server-written only), workout streaks. `total_xp` is a trigger-maintained mirror kept for old clients. |
| `xp_events` | **append-only reward ledger**. Unique `(user_id, source_type, source_id)` is the idempotency key. `source_type` ∈ quest, workout, focus, reconciliation. |
| `quests` | quest definitions per path, with `repeat_cooldown_hours` |
| `user_active_quests` | one row per quest **instance**: `status` ∈ active, completed, abandoned. Partial unique index allows only one *active* instance per user+quest. |
| `quest_completions` | completion record per instance (note, `xp_awarded`, optional `focus_session_id`) |
| `focus_sessions` | server-timed sessions; one `running` session per user |
| `workout_logs` | one row per user per day |
| `groups`, `group_members` | guilds (`visibility` public/private, `max_members`); roles owner/member |
| `xp_reconciliation_snapshots` | pre-migration balances (audit and rollback) |

### Invariants (enforced in SQL, verified by tests)

- `profiles.xp_total == sum(xp_events.amount)` for every user.
- One earning event → at most one ledger row (unique key + `ON CONFLICT DO NOTHING` inside `_award_xp`). Concurrent duplicates block on the unique index and then no-op.
- Users cannot write XP, streaks, ledger, quests or memberships directly (privileges revoked; RLS allows own-row SELECT only).
- Level = `floor(xp / 100) + 1`. Rank thresholds E 0, D 500, C 1,500, B 5,000, A 15,000, S 50,000. These are defined once in `lib/progression.js`.

### Quest lifecycle

```
Available ──accept_quest──► Active ──complete_active_quest──► Completed (history)
                              └──abandon_active_quest──► Abandoned (no XP)
Completed quest ──(after cooldown)──► can be accepted again as a NEW instance
```

- `accept_quest` takes a per-user advisory lock, so the 5-active limit cannot be raced. It returns the existing instance if the quest is already active, and refuses during the cooldown.
- `complete_active_quest` locks the instance row. A retry returns `newly_completed=false` with no new XP. Other users' instances return "not found".

### Focus engine

- **Client**: `focusEngine.js` is a pure state machine (`idle → running ⇄ paused → finishing → completed`) storing `accumulatedMs` and `runningSince`. Remaining time is always computed from `Date.now()`, never from tick counts. State persists per user in `localStorage` and syncs across tabs through the `storage` event. The interval only triggers re-renders and completion checks.
- **Server**: `start_focus_session` records `started_at`. `complete_focus_session` requires `now() - started_at ≥ focused_seconds` (5 s tolerance), awards 1 XP per full 5 minutes, caps focus XP at 48/day, and is idempotent. Starting a new session abandons the previous running one, so completed sessions never overlap.
- If the start RPC fails, the timer still runs but is labelled "Not recorded (offline)" and awards nothing.

### Guild authorization

- `guild_create`, `guild_join_by_code`, `guild_join_public` (public guilds only), `guild_leave` (transfers ownership to the longest-standing member), `guild_my_guilds` (the only source of invite codes), `guild_list_public`, `guild_leaderboard` (members only; returns display name, role, XP and `is_self`; **no user ids or emails**).
- `groups.invite_code` has no column SELECT grant for clients.

## PWA

`registerType: 'prompt'`: a new deployment shows an in-app "Reload" banner instead of swapping assets mid-session. It also checks for updates hourly. Only same-origin build assets are precached, and there is no `runtimeCaching`, so Supabase API and auth responses are never cached. Vercel serves `sw.js`, `index.html` and the manifest with `max-age=0, must-revalidate`; hashed assets are immutable.
