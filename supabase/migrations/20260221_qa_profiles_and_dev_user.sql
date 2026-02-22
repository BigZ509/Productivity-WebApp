-- QA profile + seed setup for MVP
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  is_qa boolean not null default false,
  perks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'on_auth_user_created_profile'
  ) then
    create trigger on_auth_user_created_profile
      after insert on auth.users
      for each row execute function public.handle_new_user_profile();
  end if;
end
$$;

create or replace function public.is_qa_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid() and p.is_qa = true
  );
$$;

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_own'
  ) then
    create policy profiles_select_own
      on public.profiles
      for select
      using (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_insert_own'
  ) then
    create policy profiles_insert_own
      on public.profiles
      for insert
      with check (auth.uid() = id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_own'
  ) then
    create policy profiles_update_own
      on public.profiles
      for update
      using (auth.uid() = id)
      with check (auth.uid() = id);
  end if;
end
$$;

-- QA read-only access to test-only tables.
-- This intentionally scopes to tables prefixed with qa_ to avoid private user data tables.
do $$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like 'qa\_%' escape '\'
  loop
    execute format('alter table %I.%I enable row level security', r.schema_name, r.table_name);

    if not exists (
      select 1
      from pg_policies p
      where p.schemaname = r.schema_name
        and p.tablename = r.table_name
        and p.policyname = 'qa_read_test_table'
    ) then
      execute format(
        'create policy qa_read_test_table on %I.%I for select using (public.is_qa_user())',
        r.schema_name,
        r.table_name
      );
    end if;
  end loop;
end
$$;

do $$
declare
  qa_email constant text := 'test@test.com';
  qa_password constant text := '123456';
  qa_user_id uuid;
begin
  select id into qa_user_id
  from auth.users
  where email = qa_email
  limit 1;

  if qa_user_id is null then
    qa_user_id := gen_random_uuid();

    insert into auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      is_sso_user,
      is_anonymous
    )
    values (
      qa_user_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      qa_email,
      crypt(qa_password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(),
      now(),
      false,
      false
    );

    insert into auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      created_at,
      updated_at
    )
    values (
      gen_random_uuid(),
      qa_user_id,
      jsonb_build_object('sub', qa_user_id::text, 'email', qa_email),
      'email',
      qa_email,
      now(),
      now()
    )
    on conflict (provider, provider_id) do nothing;
  else
    update auth.users
    set
      encrypted_password = crypt(qa_password, gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at = now()
    where id = qa_user_id;
  end if;

  insert into public.profiles (id, username, is_qa, perks)
  values (
    qa_user_id,
    'qa_tester',
    true,
    '{
      "unlimited_xp": true,
      "skip_cooldowns": true,
      "all_themes": true,
      "all_presets": true,
      "dev_tools": true
    }'::jsonb
  )
  on conflict (id) do update
  set
    is_qa = excluded.is_qa,
    perks = excluded.perks,
    username = coalesce(public.profiles.username, excluded.username);
end
$$;
