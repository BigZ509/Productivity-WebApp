# Deferred features

Left out on purpose so the core loop is reliable. None of these appear in the UI as finished features.

| Item | Status | Why deferred / what's needed |
|---|---|---|
| Boss fights | Removed from nav (`/boss` → dashboard) | The old version subtracted fixed HP per click and gave no durable rewards. Rebuild as a weekly challenge driven by real quest completions (server-side aggregate over `xp_events`). |
| AI quest generator | Removed from nav (`/ai` → dashboard) | It was a placeholder. Needs a server-side function; LLM keys must never be in the browser. |
| Guild chat, guild XP/levels, raid quests, activity feed | Removed | All of these were local state. They need real tables, RLS and moderation. |
| Guild challenges | Hidden | `challenges` tables exist but have no progress model. Build on the ledger once the challenge rules are defined. |
| Skill spending / perks | Replaced by milestones | Fictional purchases with no effects. If wanted: a separate spendable currency, server-validated unlocks, and real effects. |
| Daily check-in reward | Removed | It was client-side and farmable. Could return as an idempotent `claim_daily_checkin()` RPC keyed by date. |
| Lab sync (journal, habits, planner, reading, nutrition, goals, trading, portfolio) | Device-only, labelled | Needs tables and RLS per tool. Trading and portfolio are marked experimental. |
| Password reset flow | Not built | Add a `/auth/reset` page using `resetPasswordForEmail` + `updateUser`. |
| Guild role management (promote/kick) | Not built | Ownership transfers automatically when the owner leaves; there is no other role mutation. |
| Push/notification reminders for focus | Not built | The chime and tab-title countdown cover the demo. |
| Ranked global leaderboard | Not built | Only per-guild boards, which avoids exposing all users. |
| Unused image assets in `src/assets/` | Left in repo | Not bundled. They appear to be third-party anime art; recommend deleting. |
