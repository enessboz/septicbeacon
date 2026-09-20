-- RVFixWise v4.7 Media Library + R2 metadata
-- Run once in Supabase SQL Editor.
-- Safe to run more than once.

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete set null,
  storage_key text not null,
  public_url text,
  media_type text not null default 'image',
  alt_text text,
  prompt text,
  width int,
  height int,
  bytes bigint,
  created_at timestamptz not null default now()
);

alter table public.media add column if not exists caption text;
alter table public.media add column if not exists original_name text;
alter table public.media add column if not exists mime_type text default 'image/webp';
alter table public.media add column if not exists updated_at timestamptz not null default now();

create unique index if not exists media_site_storage_key_uidx
  on public.media(site_id, storage_key);
create index if not exists media_site_created_idx
  on public.media(site_id, created_at desc);
create index if not exists media_article_idx
  on public.media(article_id);

alter table public.media enable row level security;

revoke all on public.media from anon;
grant select, insert, update, delete on public.media to authenticated;

drop policy if exists media_member_select on public.media;
create policy media_member_select on public.media
for select to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor','reviewer','viewer']::public.app_role[]
  )
);

drop policy if exists media_member_write on public.media;
create policy media_member_write on public.media
for all to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor']::public.app_role[]
  )
)
with check (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor']::public.app_role[]
  )
);

create or replace function public.touch_media_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at=now();
  return new;
end $$;

drop trigger if exists media_touch_updated_at on public.media;
create trigger media_touch_updated_at
before update on public.media
for each row execute function public.touch_media_updated_at();
