-- 20260301_quest_expansion_and_names.sql
-- Quest expansion (life systems + fitness + productivity) + display-name hygiene

-- Ensure optional columns exist for richer quest cards.
alter table public.quests add column if not exists is_active boolean not null default true;
alter table public.quests add column if not exists flavor_text text not null default '';

-- Backfill display names so leaderboard can show chosen in-game tags.
alter table public.profiles add column if not exists display_name text;

update public.profiles
set display_name = username
where coalesce(display_name, '') = ''
  and coalesce(username, '') <> '';

-- If username accidentally includes full email, convert to safe hunter handle.
update public.profiles
set username = concat('Hunter#', right(replace(id::text, '-', ''), 4))
where username like '%@%';

update public.profiles
set display_name = username
where coalesce(display_name, '') = '';

insert into public.quests (title, description, path, category, difficulty, xp_reward, is_active, flavor_text)
values
-- HUNTER: GYM
('30-Min Zone 2 Run', 'Run for 30 minutes at steady conversational pace.', 'HUNTER', 'gym', 'medium', 28, true, 'Endurance builds execution stamina.'),
('20 Push-Ups Challenge', 'Complete 20 strict push-ups with good form.', 'HUNTER', 'gym', 'easy', 12, true, 'Small reps compound fast.'),
('Jump Rope 30 Minutes', 'Accumulate 30 minutes total jump rope.', 'HUNTER', 'gym', 'hard', 35, true, 'Footwork + cardio under control.'),
('45-Minute Walk', 'Walk 45 minutes outdoors with pace intent.', 'HUNTER', 'gym', 'easy', 15, true, 'Low-intensity discipline stack.'),
('Mobility Reset 20m', 'Hip/ankle/thoracic mobility flow for 20 minutes.', 'HUNTER', 'gym', 'easy', 14, true, 'Move well to perform well.'),
('Core Stability Circuit', '3 rounds: plank, dead bug, side plank.', 'HUNTER', 'gym', 'medium', 18, true, 'Midline strength protects output.'),
('Stair Session 20m', '20 minutes stair climber or incline stairs.', 'HUNTER', 'gym', 'medium', 24, true, 'Engine over ego.'),
('Leg Day Compliance', 'Complete your full lower-body plan with notes.', 'HUNTER', 'gym', 'hard', 40, true, 'No skipped foundations.'),

-- HUNTER: STUDY
('Read 20 Pages + Notes', 'Read 20 pages and write 5 bullet notes.', 'HUNTER', 'study', 'easy', 16, true, 'Consume less, retain more.'),
('Flashcards 30 Reps', 'Complete 30 active-recall reps.', 'HUNTER', 'study', 'easy', 14, true, 'Recall is the score.'),
('Deep Study 60m', 'One uninterrupted 60-minute study block.', 'HUNTER', 'study', 'medium', 26, true, 'Attention is your edge.'),
('Teach-Back Drill', 'Explain one concept out loud in plain language.', 'HUNTER', 'study', 'medium', 20, true, 'If you can teach it, you own it.'),
('Research Synthesis', 'Summarize 3 sources into one actionable page.', 'HUNTER', 'study', 'hard', 34, true, 'Signal over noise.'),

-- HUNTER: CODING
('Fix 2 Bugs', 'Close two real bugs and leave clear notes.', 'HUNTER', 'coding', 'medium', 26, true, 'Stability is a feature.'),
('Ship 1 Small Feature', 'Deploy a scoped feature to production.', 'HUNTER', 'coding', 'hard', 42, true, 'Shipping beats polishing.'),
('Refactor 1 Module', 'Refactor one module with no behavior regression.', 'HUNTER', 'coding', 'medium', 30, true, 'Clean code compounds speed.'),
('Write 3 Tests', 'Add three meaningful tests for critical paths.', 'HUNTER', 'coding', 'medium', 22, true, 'Confidence equals velocity.'),
('Code Sprint 90m', 'Focused coding sprint, no context switching.', 'HUNTER', 'coding', 'hard', 36, true, 'Create momentum through depth.'),

-- HUNTER: BUSINESS
('Prospect Outreach x15', 'Send 15 targeted outreach messages.', 'HUNTER', 'business', 'hard', 36, true, 'Pipeline is power.'),
('Follow-Ups x10', 'Follow up with 10 warm leads.', 'HUNTER', 'business', 'medium', 24, true, 'Fortune follows follow-up.'),
('Offer Audit', 'Improve one key section of your offer page.', 'HUNTER', 'business', 'medium', 26, true, 'Sharper positioning, better conversion.'),
('Publish 1 Content Piece', 'Publish one educational post with CTA.', 'HUNTER', 'business', 'medium', 24, true, 'Document > disappear.'),
('Sales Call Review', 'Review one call and extract 5 lessons.', 'HUNTER', 'business', 'hard', 30, true, 'Feedback is fuel.'),

-- HEAVENLY_DEMON: GYM
('Demon Run 30m', '30-minute controlled run with no breaks.', 'HEAVENLY_DEMON', 'gym', 'medium', 30, true, 'Control pace. Control mind.'),
('Push-Up Ladder 50', 'Accumulate 50 push-ups in ladder format.', 'HEAVENLY_DEMON', 'gym', 'hard', 32, true, 'Volume under discipline.'),
('Jump Rope War 30m', '30-minute jump rope session with interval pushes.', 'HEAVENLY_DEMON', 'gym', 'hard', 38, true, 'Rhythm and conditioning.'),
('Strength Block Complete', 'Finish full programmed strength block.', 'HEAVENLY_DEMON', 'gym', 'hard', 44, true, 'Power through precision.'),
('Recovery Protocol', 'Sleep prep + mobility + hydration compliance.', 'HEAVENLY_DEMON', 'gym', 'easy', 16, true, 'Recovery is tactical.'),

-- HEAVENLY_DEMON: STUDY
('Tactical Study 90m', '90-minute deep study with no interruptions.', 'HEAVENLY_DEMON', 'study', 'hard', 34, true, 'Depth over distraction.'),
('Memory Vault 40', '40 active-recall cards completed.', 'HEAVENLY_DEMON', 'study', 'medium', 24, true, 'Memory under pressure.'),
('Doctrine Notes', 'Write one page of distilled doctrine notes.', 'HEAVENLY_DEMON', 'study', 'medium', 22, true, 'Codify what matters.'),
('Concept Drill', 'Solve 15 hard problems in one topic.', 'HEAVENLY_DEMON', 'study', 'hard', 40, true, 'Repetition creates certainty.'),
('Silent Reading 45m', 'Read 45 minutes, summarize 3 insights.', 'HEAVENLY_DEMON', 'study', 'easy', 18, true, 'Extract signal quickly.'),

-- HEAVENLY_DEMON: CODING
('High-Risk Feature Push', 'Ship a difficult feature with rollback plan.', 'HEAVENLY_DEMON', 'coding', 'hard', 56, true, 'Calm execution under risk.'),
('Debug Marathon', '90 minutes dedicated debugging sprint.', 'HEAVENLY_DEMON', 'coding', 'hard', 36, true, 'Trace reality to root cause.'),
('System Refactor', 'Refactor one subsystem + keep tests green.', 'HEAVENLY_DEMON', 'coding', 'hard', 48, true, 'Architecture is destiny.'),
('Performance Sweep', 'Identify and fix one measurable bottleneck.', 'HEAVENLY_DEMON', 'coding', 'medium', 32, true, 'Speed is user trust.'),
('Ship + Postmortem', 'Deploy and write a short technical postmortem.', 'HEAVENLY_DEMON', 'coding', 'hard', 44, true, 'Ship and learn immediately.'),

-- HEAVENLY_DEMON: BUSINESS
('Revenue Hunt x20', '20 quality prospect touches in one block.', 'HEAVENLY_DEMON', 'business', 'hard', 42, true, 'Hunt with precision.'),
('Offer Reframe', 'Rebuild value prop + objection handling.', 'HEAVENLY_DEMON', 'business', 'medium', 30, true, 'Clarity converts.'),
('Pipeline Cleanup', 'Update CRM and next actions for all open deals.', 'HEAVENLY_DEMON', 'business', 'medium', 26, true, 'No stale opportunities.'),
('Closing Sprint', 'Run one focused closing block on hot leads.', 'HEAVENLY_DEMON', 'business', 'hard', 46, true, 'Ask for the decision.'),
('Night Audit', 'End-day tactical review and next-day strike plan.', 'HEAVENLY_DEMON', 'business', 'easy', 15, true, 'Plan before sleep.')
on conflict (path, title) do update
set description = excluded.description,
    category = excluded.category,
    difficulty = excluded.difficulty,
    xp_reward = excluded.xp_reward,
    is_active = excluded.is_active,
    flavor_text = excluded.flavor_text;

update public.quests
set is_active = true
where path in ('HUNTER', 'HEAVENLY_DEMON');

select pg_notify('pgrst', 'reload schema');
