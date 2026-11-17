-- =====================================================================
-- QA account remediation (MANUAL, privileged). Review 01_preflight_audit.sql
-- output first. Run each block deliberately; nothing here runs automatically.
-- =====================================================================

-- Option A (recommended): ban the publicly-known QA account so its leaked
-- password is useless, while keeping its rows for audit.
-- update auth.users
-- set banned_until = 'infinity', updated_at = now()
-- where email = 'test@test.com';
--
-- Then revoke any live sessions/refresh tokens for it:
-- delete from auth.refresh_tokens where user_id = (select id from auth.users where email = 'test@test.com');
-- delete from auth.sessions where user_id = (select id from auth.users where email = 'test@test.com');

-- Option B: delete it entirely (cascades its profile, quests, XP, memberships).
-- Prefer the dashboard (Authentication -> Users -> Delete) or:
-- select auth.uid(); -- (sanity: run as service role / postgres)
-- delete from auth.users where email = 'test@test.com';

-- Repair rows created by hand-written auth seeds (NULL token columns).
-- update auth.users
-- set confirmation_token = coalesce(confirmation_token, ''),
--     recovery_token = coalesce(recovery_token, ''),
--     email_change_token_new = coalesce(email_change_token_new, ''),
--     email_change = coalesce(email_change, '')
-- where confirmation_token is null or recovery_token is null
--    or email_change_token_new is null or email_change is null;

-- Provision a NEW restricted demo account instead (no privileges, no perks):
-- use `npm run demo:reset` against a dedicated QA/demo project with
-- DEMO_USER_EMAIL / DEMO_USER_PASSWORD supplied from a secret store.
