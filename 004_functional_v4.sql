-- RVFixWise Functional v4 patch
-- Run in Supabase SQL Editor after the existing schema.

-- Public website read access.
grant select on public.categories, public.articles, public.people to anon;

drop policy if exists categories_public_select on public.categories;
create policy categories_public_select on public.categories
for select to anon
using (is_active = true);

drop policy if exists articles_public_select on public.articles;
create policy articles_public_select on public.articles
for select to anon
using (status = 'published');

drop policy if exists people_public_select on public.people;
create policy people_public_select on public.people
for select to anon
using (is_active = true);

-- Helper: member read policy for site-scoped admin tables.
-- Explicit policies are added because RLS is enabled.
drop policy if exists categories_member_all on public.categories;
create policy categories_member_all on public.categories
for all to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id, array['owner','admin','editor']::public.app_role[]));

drop policy if exists people_member_all on public.people;
create policy people_member_all on public.people
for all to authenticated
using (public.user_has_site_role(site_id, array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id, array['owner','admin','editor']::public.app_role[]));

drop policy if exists article_sources_member_all on public.article_sources;
create policy article_sources_member_all on public.article_sources
for all to authenticated
using (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[])))
with check (exists(select 1 from public.articles a where a.id=article_id and public.user_has_site_role(a.site_id,array['owner','admin','editor']::public.app_role[])));

drop policy if exists internal_links_member_all on public.internal_links;
create policy internal_links_member_all on public.internal_links
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists topic_keywords_member_all on public.topic_keywords;
create policy topic_keywords_member_all on public.topic_keywords
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists calendar_member_all on public.content_calendar;
create policy calendar_member_all on public.content_calendar
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists gsc_daily_member_select on public.gsc_daily;
create policy gsc_daily_member_select on public.gsc_daily
for select to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]));

drop policy if exists ga4_daily_member_select on public.ga4_daily;
create policy ga4_daily_member_select on public.ga4_daily
for select to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]));

drop policy if exists opp_member_all on public.seo_opportunities;
create policy opp_member_all on public.seo_opportunities
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists crawl_runs_member_all on public.crawl_runs;
create policy crawl_runs_member_all on public.crawl_runs
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists crawl_urls_member_select on public.crawl_urls;
create policy crawl_urls_member_select on public.crawl_urls
for select to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]));

drop policy if exists alerts_member_all on public.alerts;
create policy alerts_member_all on public.alerts
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists redirects_member_all on public.redirects;
create policy redirects_member_all on public.redirects
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists jobs_member_all on public.jobs;
create policy jobs_member_all on public.jobs
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin','editor']::public.app_role[]));

drop policy if exists integrations_member_all on public.integrations;
create policy integrations_member_all on public.integrations
for all to authenticated
using (public.user_has_site_role(site_id,array['owner','admin','editor','reviewer','viewer']::public.app_role[]))
with check (public.user_has_site_role(site_id,array['owner','admin']::public.app_role[]));

-- Make sure authenticated role can access these tables through PostgREST.
grant select, insert, update, delete on
  public.categories, public.people, public.article_sources, public.internal_links,
  public.topic_keywords, public.content_calendar, public.seo_opportunities,
  public.crawl_runs, public.crawl_urls, public.alerts, public.redirects,
  public.jobs, public.integrations
to authenticated;

grant select on public.gsc_daily, public.ga4_daily to authenticated;
