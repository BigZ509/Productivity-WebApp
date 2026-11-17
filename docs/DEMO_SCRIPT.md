# Demo Script (about 6 minutes)

## Setup (once, before the audience arrives)

**Use the local stack or a dedicated QA project, never the production project.**

```bash
npm run db:start                       # local Supabase (Docker)
export DEMO_USER_EMAIL=<demo email> DEMO_USER_PASSWORD=<from your secret store, 12+ chars>
npm run demo:reset                     # rebuilds the demo Hunter, guild and rivals
npx vite --mode e2e                    # http://localhost:5173
```

For a hosted QA project: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… DEMO_ALLOW_REMOTE=yes node scripts/demo-seed.mjs --reset --remote`, then deploy the frontend with that project's URL and anon key (and `VITE_DEMO_MODE=true`).

What the seed creates: **Kai Ardent** (Hunter, Level 5, **470 XP**, E-Rank, 30 XP from D-Rank), 9 completed quests over the last 9 days, 4 workouts, 2 focus sessions, 2 active quests, and the public guild **Midnight Raiders** with three rivals and real weekly XP. `demo:reset` touches only these accounts.

## The walkthrough

| # | Do | Say / point out |
|---|---|---|
| 1 | Open the app. | Loads straight to sign-in, with no spinner loop. "Turn the work you need to do into progress you can see." |
| 2 | Sign in as the demo user. | A normal account. There is no hidden dev login and no universal password. |
| 3 | **Command Center.** | The top card is *what to do next*. Right rail: rank emblem, Level 5, 470 XP, 30 XP to D-Rank, a 9-day activity streak, and a real weekly XP chart. Everything comes from the ledger. |
| 4 | **Quests** → filter **Coding** → **Accept** "Ship 1 Small Feature" (+42 XP). | It appears under Active. 3 of 5 slots are used; the server enforces the limit. |
| 5 | Click **Focus** on it → **Custom 1** minute → **Begin**. Go to **Command**, then back to **Focus**, then **reload**. | The focus pill follows you between screens, and the timer is still accurate after a reload because it's timestamp-based. "Recording to your account": the server checks real elapsed time. |
| 6 | When the bell sounds: **Complete quest (+42 XP)**. | Reward card: **+42 XP · Rank up: D-Rank Hunter**. Completing again awards nothing; it's idempotent on the server. |
| 7 | **Command**, then **Character**. | Level 6 · 512 XP everywhere. The rank ladder and achievements are milestones, not purchases. Mastery by category. |
| 8 | **Guild**. | Midnight Raiders: you're #1 this week. Switch to All time. Invite codes are visible to members only, and the leaderboard never exposes emails. |
| 9 | Refresh the browser. | Completed quest (History tab), XP and guild all persist. |
| 10 | **Sign out**, then sign in again. | Same state. |

Optional extras:
- **Theme:** create a second account and choose **Heavenly Demon** during onboarding. The same app becomes ember-red, with "Trials" and the "Meditation Chamber".
- **Mobile:** narrow the window to 390px. You get a bottom tab bar plus a "More" sheet.

## Running it again

Run `npm run demo:reset` between demos to restore the exact starting state (470 XP, so the rank-up moment repeats). Without a reset, pick a different quest: completed quests have a 20-hour cooldown by design. The automated suite runs this journey twice back to back, the second time with "Bug Zero Hour".

## If something goes wrong

- *"The server is missing a required update"*: the target database lacks migration `20261117000100`.
- Sign-in fails: rerun `npm run demo:reset` (it also resets the password from your env).
- The timer says "Not recorded (offline)": the start call failed (network). The timer still runs but awards nothing.
