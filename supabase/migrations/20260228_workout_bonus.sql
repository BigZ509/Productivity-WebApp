-- ============================================================
-- 20260228_workout_bonus.sql
-- Adds optional cardio bonus XP handling to log_workout RPC.
-- - 45 min walk: +10 XP
-- - 45 min run:  +15 XP
-- ============================================================

create or replace function public.log_workout(
  p_date date,
  p_completed boolean,
  p_optional_payload jsonb default '{}'::jsonb
)
returns table(awarded_xp int, bonus_xp int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log_id uuid;
  v_rows int;
  v_base_xp int := 40;
  v_bonus_xp int := 0;
  v_total_xp int := 0;
  v_walk_bonus boolean := coalesce((p_optional_payload->>'bonus_walk_45')::boolean, false);
  v_run_bonus boolean := coalesce((p_optional_payload->>'bonus_run_45')::boolean, false);
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.workout_logs(user_id, log_date, completed, payload)
  values (auth.uid(), p_date, p_completed, p_optional_payload)
  on conflict (user_id, log_date)
  do update set completed = excluded.completed, payload = excluded.payload
  returning id into v_log_id;

  if p_completed then
    if v_walk_bonus then
      v_bonus_xp := v_bonus_xp + 10;
    end if;
    if v_run_bonus then
      v_bonus_xp := v_bonus_xp + 15;
    end if;

    v_total_xp := v_base_xp + v_bonus_xp;

    insert into public.xp_events(user_id, source_type, source_id, amount)
    values (auth.uid(), 'workout', v_log_id, v_total_xp)
    on conflict do nothing;

    get diagnostics v_rows = row_count;

    if v_rows > 0 then
      update public.profiles
      set xp_total = xp_total + v_total_xp,
          last_workout_date = p_date
      where id = auth.uid();
    else
      v_total_xp := 0;
      v_bonus_xp := 0;
    end if;
  end if;

  perform public.recalculate_streaks(auth.uid());

  return query select coalesce(v_total_xp, 0), coalesce(v_bonus_xp, 0);
end;
$$;

grant execute on function public.log_workout(date, boolean, jsonb) to authenticated;
