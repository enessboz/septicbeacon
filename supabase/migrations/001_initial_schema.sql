-- RVFixWise Database Schema v1
-- Target: Supabase Postgres
-- Single-site today, multi-site ready through site_id.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- ENUMS
-- ------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('owner','admin','editor','reviewer','viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.content_status as enum (
    'idea','brief','draft','editorial_qa','technical_review',
    'ready','scheduled','published','refresh','archived'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.content_type as enum (
    'troubleshooting','how_to','maintenance','best','comparison','guide','hub'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.job_status as enum ('queued','running','review','completed','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.opportunity_type as enum (
    'content_gap','low_hanging','ctr','content_decay','cannibalization',
    'internal_link','indexation','technical'
  );
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- CORE / ACCESS
-- ------------------------------------------------------------
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  timezone text not null default 'America/New_York',
  locale text not null default 'en-US',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_members (
  site_id uuid not null references public.sites(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null,
  primary key (site_id, user_id)
);

-- ------------------------------------------------------------
-- TAXONOMY / PEOPLE
-- ------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  parent_id uuid references public.categories(id) on delete set null,
  name text not null,
  slug text not null,
  description text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  unique(site_id, slug)
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  name text not null,
  slug text not null,
  person_type text not null check (person_type in ('author','reviewer','both')),
  title text,
  bio text,
  credentials text,
  avatar_url text,
  is_active boolean not null default true,
  unique(site_id, slug)
);

-- ------------------------------------------------------------
-- CONTENT
-- ------------------------------------------------------------
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  author_id uuid references public.people(id) on delete set null,
  reviewer_id uuid references public.people(id) on delete set null,

  title text not null,
  slug text not null,
  content_type public.content_type not null default 'guide',
  status public.content_status not null default 'draft',

  primary_keyword text,
  search_intent text,

  -- Work-friendly master input. Parsed/rendered later.
  content_markdown text not null default '',
  content_blocks jsonb not null default '[]'::jsonb,

  excerpt text,
  quick_answer text,

  seo_title text,
  meta_description text,
  canonical_path text,

  featured_image_url text,
  featured_image_alt text,
  featured_image_prompt text,

  reviewer_required boolean not null default false,
  reviewer_completed_at timestamptz,
  editorial_checked_at timestamptz,

  publish_score smallint check (publish_score between 0 and 100),
  scheduled_at timestamptz,
  published_at timestamptz,
  first_published_at timestamptz,
  last_reviewed_at timestamptz,

  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(site_id, slug)
);

create index if not exists articles_site_status_idx on public.articles(site_id, status);
create index if not exists articles_category_idx on public.articles(category_id);
create index if not exists articles_published_idx on public.articles(site_id, published_at desc);
create index if not exists articles_keyword_idx on public.articles(site_id, primary_keyword);

create table if not exists public.article_revisions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  revision_no int not null,
  title text not null,
  content_markdown text not null,
  content_blocks jsonb not null default '[]'::jsonb,
  seo_title text,
  meta_description text,
  change_note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(article_id, revision_no)
);

create table if not exists public.article_sources (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  label text not null,
  url text,
  source_type text not null default 'reference'
    check (source_type in ('primary','manufacturer','official','technical','reference','expert')),
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.internal_links (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  source_article_id uuid not null references public.articles(id) on delete cascade,
  target_article_id uuid references public.articles(id) on delete cascade,
  target_path text,
  anchor_text text not null,
  link_context text,
  is_suggested boolean not null default false,
  is_live boolean not null default false,
  created_at timestamptz not null default now(),
  check (target_article_id is not null or target_path is not null)
);

create index if not exists internal_links_source_idx on public.internal_links(source_article_id);
create index if not exists internal_links_target_idx on public.internal_links(target_article_id);

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

-- ------------------------------------------------------------
-- TOPIC MAP / CONTENT OPERATIONS
-- ------------------------------------------------------------
create table if not exists public.topic_keywords (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  target_article_id uuid references public.articles(id) on delete set null,
  keyword text not null,
  intent text,
  cluster_name text,
  priority smallint not null default 2 check (priority between 0 and 3),
  status text not null default 'unmapped'
    check (status in ('unmapped','mapped','gap','brief','draft','published','refresh')),
  search_volume int,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, keyword)
);

create table if not exists public.content_calendar (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete cascade,
  event_type text not null check (event_type in ('brief','draft','editorial_qa','technical_review','publish','refresh')),
  scheduled_for timestamptz not null,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SEARCH CONSOLE / ANALYTICS
-- ------------------------------------------------------------
create table if not exists public.gsc_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  page text not null default '',
  query text not null default '',
  country text not null default '',
  device text not null default '',
  clicks numeric not null default 0,
  impressions numeric not null default 0,
  ctr numeric not null default 0,
  position numeric,
  primary key (site_id, date, page, query, country, device)
);

create index if not exists gsc_daily_page_date_idx on public.gsc_daily(site_id, page, date desc);
create index if not exists gsc_daily_query_date_idx on public.gsc_daily(site_id, query, date desc);

create table if not exists public.gsc_url_inspections (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete set null,
  inspected_url text not null,
  verdict text,
  coverage_state text,
  indexing_state text,
  robots_txt_state text,
  page_fetch_state text,
  google_canonical text,
  user_canonical text,
  last_crawl_time timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  inspected_at timestamptz not null default now()
);

create index if not exists gsc_inspection_url_idx
  on public.gsc_url_inspections(site_id, inspected_url, inspected_at desc);

create table if not exists public.ga4_daily (
  site_id uuid not null references public.sites(id) on delete cascade,
  date date not null,
  landing_page text not null default '',
  sessions numeric not null default 0,
  active_users numeric not null default 0,
  engaged_sessions numeric not null default 0,
  engagement_rate numeric,
  views numeric not null default 0,
  primary key (site_id, date, landing_page)
);

-- ------------------------------------------------------------
-- SEO ENGINE / HEALTH
-- ------------------------------------------------------------
create table if not exists public.seo_opportunities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete cascade,
  keyword_id uuid references public.topic_keywords(id) on delete set null,
  type public.opportunity_type not null,
  title text not null,
  rationale text,
  priority smallint not null default 2 check (priority between 0 and 3),
  score numeric,
  status text not null default 'open'
    check (status in ('open','accepted','dismissed','in_progress','done')),
  evidence jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists opportunities_open_idx
  on public.seo_opportunities(site_id, status, priority, detected_at desc);

create table if not exists public.crawl_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  status public.job_status not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  discovered_count int not null default 0,
  indexable_count int not null default 0,
  issue_count int not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.crawl_urls (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  url text not null,
  status_code int,
  indexable boolean,
  canonical_url text,
  title text,
  h1 text,
  depth int,
  internal_inlinks int not null default 0,
  internal_outlinks int not null default 0,
  issues jsonb not null default '[]'::jsonb,
  unique(crawl_run_id, url)
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete cascade,
  alert_type text not null,
  severity text not null check (severity in ('info','low','medium','high','critical')),
  title text not null,
  message text,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open','acknowledged','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ------------------------------------------------------------
-- REDIRECTS / JOBS / INTEGRATIONS
-- ------------------------------------------------------------
create table if not exists public.redirects (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  source_path text not null,
  destination_path text not null,
  status_code int not null default 301 check (status_code in (301,302,307,308)),
  is_active boolean not null default true,
  hit_count bigint not null default 0,
  created_at timestamptz not null default now(),
  unique(site_id, source_path)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  article_id uuid references public.articles(id) on delete set null,
  job_type text not null,
  status public.job_status not null default 'queued',
  priority smallint not null default 2 check (priority between 0 and 3),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists jobs_queue_idx
  on public.jobs(status, run_after, priority, created_at);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  provider text not null,
  status text not null default 'disconnected'
    check (status in ('disconnected','connected','error','paused')),
  external_property_id text,
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(site_id, provider)
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  provider text not null,
  sync_type text not null,
  status public.job_status not null default 'queued',
  rows_written int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- UPDATED_AT TRIGGER
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists articles_set_updated_at on public.articles;
create trigger articles_set_updated_at before update on public.articles
for each row execute function public.set_updated_at();

drop trigger if exists topic_keywords_set_updated_at on public.topic_keywords;
create trigger topic_keywords_set_updated_at before update on public.topic_keywords
for each row execute function public.set_updated_at();

drop trigger if exists integrations_set_updated_at on public.integrations;
create trigger integrations_set_updated_at before update on public.integrations
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- REVISION SNAPSHOT
-- Call explicitly before major content updates.
-- ------------------------------------------------------------
create or replace function public.snapshot_article_revision(p_article_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.articles;
  next_no int;
  new_id uuid;
begin
  select * into a from public.articles where id = p_article_id;
  if not found then raise exception 'Article not found'; end if;

  select coalesce(max(revision_no),0) + 1 into next_no
  from public.article_revisions where article_id = p_article_id;

  insert into public.article_revisions(
    article_id, revision_no, title, content_markdown, content_blocks,
    seo_title, meta_description, change_note, created_by
  )
  values (
    a.id, next_no, a.title, a.content_markdown, a.content_blocks,
    a.seo_title, a.meta_description, p_note, auth.uid()
  )
  returning id into new_id;

  return new_id;
end $$;

-- ------------------------------------------------------------
-- BASIC PUBLISH GATE VIEW
-- Server/admin uses this before allowing "published".
-- ------------------------------------------------------------
create or replace view public.article_publish_gate
with (security_invoker = true)
as
select
  a.id,
  a.site_id,
  a.title,
  a.status,
  (
    a.title is not null and length(trim(a.title)) > 10
    and a.slug is not null and length(trim(a.slug)) > 3
    and a.content_markdown is not null and length(trim(a.content_markdown)) > 800
    and a.seo_title is not null and length(trim(a.seo_title)) between 20 and 70
    and a.meta_description is not null and length(trim(a.meta_description)) between 80 and 180
    and a.canonical_path is not null
    and exists(select 1 from public.article_sources s where s.article_id = a.id)
    and exists(select 1 from public.internal_links l where l.source_article_id = a.id)
    and (not a.reviewer_required or a.reviewer_completed_at is not null)
  ) as can_publish,
  jsonb_build_object(
    'has_title', a.title is not null and length(trim(a.title)) > 10,
    'has_body', a.content_markdown is not null and length(trim(a.content_markdown)) > 800,
    'has_seo_title', a.seo_title is not null and length(trim(a.seo_title)) between 20 and 70,
    'has_meta', a.meta_description is not null and length(trim(a.meta_description)) between 80 and 180,
    'has_canonical', a.canonical_path is not null,
    'has_source', exists(select 1 from public.article_sources s where s.article_id = a.id),
    'has_internal_link', exists(select 1 from public.internal_links l where l.source_article_id = a.id),
    'reviewer_ok', (not a.reviewer_required or a.reviewer_completed_at is not null)
  ) as checks
from public.articles a;

-- ------------------------------------------------------------
-- RLS HELPERS
-- ------------------------------------------------------------
create or replace function public.user_has_site_role(p_site_id uuid, allowed public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.site_members sm
    where sm.site_id = p_site_id
      and sm.user_id = auth.uid()
      and sm.role = any(allowed)
  );
$$;

-- Enable RLS on all exposed public tables.
alter table public.sites enable row level security;
alter table public.profiles enable row level security;
alter table public.site_members enable row level security;
alter table public.categories enable row level security;
alter table public.people enable row level security;
alter table public.articles enable row level security;
alter table public.article_revisions enable row level security;
alter table public.article_sources enable row level security;
alter table public.internal_links enable row level security;
alter table public.media enable row level security;
alter table public.topic_keywords enable row level security;
alter table public.content_calendar enable row level security;
alter table public.gsc_daily enable row level security;
alter table public.gsc_url_inspections enable row level security;
alter table public.ga4_daily enable row level security;
alter table public.seo_opportunities enable row level security;
alter table public.crawl_runs enable row level security;
alter table public.crawl_urls enable row level security;
alter table public.alerts enable row level security;
alter table public.redirects enable row level security;
alter table public.jobs enable row level security;
alter table public.integrations enable row level security;
alter table public.sync_runs enable row level security;

-- Revoke broad defaults. Server-side service_role keeps bypass behavior.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- Admin CMS users can use the Data API, but RLS still limits rows.
grant select, insert, update, delete on
  public.sites, public.profiles, public.site_members, public.categories,
  public.people, public.articles, public.article_revisions, public.article_sources,
  public.internal_links, public.media, public.topic_keywords, public.content_calendar,
  public.gsc_daily, public.gsc_url_inspections, public.ga4_daily,
  public.seo_opportunities, public.crawl_runs, public.crawl_urls, public.alerts,
  public.redirects, public.jobs, public.integrations, public.sync_runs
to authenticated;

grant select on public.article_publish_gate to authenticated;

-- Minimal profile self-read
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
for select to authenticated
using (id = auth.uid());

-- Sites visible only to members
drop policy if exists sites_member_select on public.sites;
create policy sites_member_select on public.sites
for select to authenticated
using (public.user_has_site_role(id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]));

-- Generic site-scoped policies for key CMS tables.
-- We intentionally keep writes to owner/admin/editor; reviewer can read.
drop policy if exists articles_member_select on public.articles;
create policy articles_member_select on public.articles
for select to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]));

drop policy if exists articles_editor_insert on public.articles;
create policy articles_editor_insert on public.articles
for insert to authenticated
with check (public.user_has_site_role(site_id, array['owner','admin','editor']::public.app_role[]));

drop policy if exists articles_editor_update on public.articles;
create policy articles_editor_update on public.articles
for update to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor']::public.app_role[]))
with check (public.user_has_site_role(site_id, array['owner','admin','editor']::public.app_role[]));

drop policy if exists articles_admin_delete on public.articles;
create policy articles_admin_delete on public.articles
for delete to authenticated
using (public.user_has_site_role(site_id, array['owner','admin']::public.app_role[]));

-- For remaining site-scoped tables, start with member read + editor write.
-- Production migrations should add per-operation policies table-by-table.
