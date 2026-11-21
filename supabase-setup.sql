-- Aftertone: таблицы, хранилище и правила доступа.
-- Вставьте целиком в Supabase → SQL Editor → New query → Run.
-- Каждый пользователь видит и меняет только свои дни, капсулы и файлы.

-- Дни дневника
create table if not exists public.days (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,
  date       date,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Капсулы времени
create table if not exists public.capsules (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.days     enable row level security;
alter table public.capsules enable row level security;

drop policy if exists "days: свои" on public.days;
create policy "days: свои" on public.days
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "capsules: свои" on public.capsules;
create policy "capsules: свои" on public.capsules
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Хранилище для фото, картинок дня и фрагментов песен (приватное)
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Файлы лежат в папке с id пользователя: <user_id>/<day_id>/photo-0.jpg
drop policy if exists "media: читать свои" on storage.objects;
create policy "media: читать свои" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media: загружать свои" on storage.objects;
create policy "media: загружать свои" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media: обновлять свои" on storage.objects;
create policy "media: обновлять свои" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media: удалять свои" on storage.objects;
create policy "media: удалять свои" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
