-- RVFixWise Functional v4.2
-- GSC verification + secure OAuth credential storage.
-- Run after 004_functional_v4.sql.

create table if not exists public.site_verification (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  provider text not null default 'gsc',
  verification_method text not null default 'meta'
    check (verification_method in ('meta','html_file','dns')),
  meta_token text,
  html_filename text,
  html_content text,
  dns_record_name text,
  dns_record_value text,
  enabled boolean not null default true,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(site_id, provider)
);

alter table public.site_verification enable row level security;
revoke all on public.site_verification from anon;
revoke all on public.site_verification from authenticated;
grant select on public.site_verification to anon;
grant select, insert, update, delete on public.site_verification to authenticated;

drop policy if exists site_verification_public_read on public.site_verification;
create policy site_verification_public_read on public.site_verification
for select to anon
using (provider='gsc' and enabled=true);

drop policy if exists site_verification_member_all on public.site_verification;
create policy site_verification_member_all on public.site_verification
for all to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor','reviewer','viewer']::public.app_role[]
  )
)
with check (
  public.user_has_site_role(
    site_id,
    array['owner','admin']::public.app_role[]
  )
);

create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  token_type text,
  scopes text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, provider)
);

alter table public.integration_credentials enable row level security;
revoke all on public.integration_credentials from anon;
revoke all on public.integration_credentials from authenticated;

create or replace function public.set_integration_credential_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at=now();
  return new;
end $$;

drop trigger if exists integration_credentials_set_updated_at on public.integration_credentials;
create trigger integration_credentials_set_updated_at
before update on public.integration_credentials
for each row execute function public.set_integration_credential_updated_at();

insert into public.integrations(site_id,provider,status)
select id,'gsc','disconnected'
from public.sites
where domain='rvfixwise.com'
on conflict(site_id,provider) do nothing;

drop policy if exists integrations_member_all on public.integrations;
create policy integrations_member_all on public.integrations
for all to authenticated
using (
  public.user_has_site_role(
    site_id,
    array['owner','admin','editor','reviewer','viewer']::public.app_role[]
  )
)
with check (
  public.user_has_site_role(
    site_id,
    array['owner','admin']::public.app_role[]
  )
);
