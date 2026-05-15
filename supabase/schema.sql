-- ═══════════════════════════════════════════════════════════════════
-- SentencIA · Supabase Schema
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════════════

-- Profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  full_name text,
  role text not null default 'pending' check (role in ('pending', 'user', 'admin')),
  anthropic_api_key text,
  created_at timestamptz default now()
);

-- Sentences history
create table if not exists public.sentences (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  causa_numero text,
  caratula text,
  tipo_accion text,
  content text not null,
  created_at timestamptz default now()
);

-- Templates (managed by admin)
create table if not exists public.templates (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  tipo text,
  content text not null,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

-- Global settings
create table if not exists public.settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- Insert default settings
insert into public.settings (key, value) values
  ('ripte_manual', '198.241,70'),
  ('app_version', '1.0.0')
on conflict (key) do nothing;

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.sentences enable row level security;
alter table public.templates enable row level security;
alter table public.settings enable row level security;

-- Profiles: users see only their own; admins see all
create policy "Users see own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Admins see all profiles" on public.profiles
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "Admins update any profile" on public.profiles
  for update using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "Users update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "Insert own profile on signup" on public.profiles
  for insert with check (auth.uid() = id);

-- Sentences: users see only their own; admins see all
create policy "Users see own sentences" on public.sentences
  for select using (
    auth.uid() = user_id OR
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "Users insert own sentences" on public.sentences
  for insert with check (auth.uid() = user_id);

-- Templates: all approved users can read; only admins can write
create policy "Approved users read templates" on public.templates
  for select using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('user', 'admin'))
  );

create policy "Admins manage templates" on public.templates
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Settings: all authenticated users can read; admins can write
create policy "Authenticated users read settings" on public.settings
  for select using (auth.role() = 'authenticated');

create policy "Admins write settings" on public.settings
  for all using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ── Function: auto-create profile on signup ───────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Make yourself admin ───────────────────────────────────────────────────────
-- IMPORTANTE: Ejecutar esto DESPUÉS de registrarse en la app por primera vez:
-- UPDATE public.profiles SET role = 'admin' WHERE email = 'TU_EMAIL@AQUI.COM';
