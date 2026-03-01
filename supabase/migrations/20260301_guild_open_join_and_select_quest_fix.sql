-- 20260301_guild_open_join_and_select_quest_fix.sql
-- Open guild browsing/join + username-safe leaderboard + idempotent quest selection

alter table if exists public.groups enable row level security;
alter table if exists public.group_members enable row level security;

-- groups: allow authenticated users to browse all guilds
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'groups' AND policyname = 'groups_select_member'
  ) THEN
    EXECUTE 'drop policy groups_select_member on public.groups';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'groups' AND policyname = 'groups_select_auth'
  ) THEN
    EXECUTE 'create policy groups_select_auth on public.groups for select to authenticated using (true)';
  END IF;
END $$;

-- group_members: allow authenticated users to view roster and join as self
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_members' AND policyname = 'group_members_select_member'
  ) THEN
    EXECUTE 'drop policy group_members_select_member on public.group_members';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_members' AND policyname = 'group_members_select_auth'
  ) THEN
    EXECUTE 'create policy group_members_select_auth on public.group_members for select to authenticated using (true)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_members' AND policyname = 'group_members_insert_self'
  ) THEN
    EXECUTE 'drop policy group_members_insert_self on public.group_members';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_members' AND policyname = 'group_members_insert_self_open'
  ) THEN
    EXECUTE 'create policy group_members_insert_self_open on public.group_members for insert to authenticated with check (user_id = auth.uid())';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'group_members' AND policyname = 'group_members_delete_self'
  ) THEN
    EXECUTE 'create policy group_members_delete_self on public.group_members for delete to authenticated using (user_id = auth.uid())';
  END IF;
END $$;

-- Leaderboard should always prefer display_name/username, never email-like fallback.
create or replace function public.get_leaderboard(p_group_id uuid, p_timeframe text default 'weekly')
returns table(user_id uuid, username text, xp integer, rank integer)
language sql
security definer
set search_path = public
as $$
  with timeframe as (
    select case
      when p_timeframe = 'weekly' then date_trunc('week', now())
      else to_timestamp(0)
    end as start_ts
  ),
  members as (
    select gm.user_id
    from public.group_members gm
    where gm.group_id = p_group_id
  ),
  sums as (
    select
      x.user_id,
      sum(x.amount)::int as xp
    from public.xp_events x, timeframe t
    where x.user_id in (select user_id from members)
      and x.created_at >= t.start_ts
    group by x.user_id
  )
  select
    m.user_id,
    coalesce(
      nullif(p.display_name, ''),
      nullif(p.username, ''),
      concat('Hunter#', right(replace(m.user_id::text, '-', ''), 4))
    ) as username,
    coalesce(s.xp, 0) as xp,
    dense_rank() over (order by coalesce(s.xp,0) desc) as rank
  from members m
  left join sums s on s.user_id = m.user_id
  left join public.profiles p on p.id = m.user_id
  order by xp desc, username asc;
$$;

grant execute on function public.get_leaderboard(uuid, text) to authenticated;

-- Idempotent quest selection with higher active limit.
create or replace function public.select_quest(p_quest_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_count integer;
  v_limit integer := 10;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- Already selected: keep active and refresh selected_at instead of failing duplicate unique key.
  if exists (
    select 1
    from public.user_active_quests
    where user_id = auth.uid()
      and quest_id = p_quest_id
  ) then
    update public.user_active_quests
    set status = 'active',
        selected_at = now()
    where user_id = auth.uid()
      and quest_id = p_quest_id;
    return;
  end if;

  select count(*)::int into v_active_count
  from public.user_active_quests
  where user_id = auth.uid()
    and status = 'active';

  if coalesce(v_active_count, 0) >= v_limit then
    raise exception 'Active quest limit reached (max %).', v_limit;
  end if;

  insert into public.user_active_quests(user_id, quest_id, status, selected_at)
  values (auth.uid(), p_quest_id, 'active', now())
  on conflict (user_id, quest_id) do update
    set status = 'active', selected_at = excluded.selected_at;
end;
$$;

grant execute on function public.select_quest(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
