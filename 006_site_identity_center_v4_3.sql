-- RVFixWise v4.3
-- Generic Site Identity & Verification Center.
-- Run once in Supabase SQL Editor after 005_gsc_setup_v4_2.sql.

create table if not exists public.site_identity_items (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  provider text not null default 'custom',
  item_type text not null
    check (item_type in ('meta','html_file','dns_txt','dns_cname','other')),
  label text not null,
  key_name text,
  value text not null,
  extra jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists site_identity_items_site_idx
  on public.site_identity_items(site_id, enabled, item_type);

alter table public.site_identity_items enable row level security;

revoke all on public.site_identity_items from anon;
grant select, insert, update, delete on public.site_identity_items to authenticated;

drop policy if exists site_identity_items_member_select on public.site_identity_items;
create policy site_identity_items_member_select on public.site_identity_items
for select to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor','reviewer','viewer']::public.app_role[]
  )
);

drop policy if exists site_identity_items_admin_write on public.site_identity_items;
create policy site_identity_items_admin_write on public.site_identity_items
for all to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin']::public.app_role[]
  )
)
with check (
  public.user_has_site_role(
    site_id,
    array['owner','admin']::public.app_role[]
  )
);

create or replace function public.set_site_identity_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at=now();
  return new;
end $$;

drop trigger if exists site_identity_items_set_updated_at on public.site_identity_items;
create trigger site_identity_items_set_updated_at
before update on public.site_identity_items
for each row execute function public.set_site_identity_updated_at();
