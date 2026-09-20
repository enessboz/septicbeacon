-- SepticBeacon seed data
insert into public.sites(name, domain, timezone, locale)
values ('SepticBeacon','septicbeacon.com','America/New_York','en-US')
on conflict(domain) do update set name=excluded.name, timezone=excluded.timezone, locale=excluded.locale;

with s as (select id from public.sites where domain='septicbeacon.com')
insert into public.categories(site_id,name,slug,sort_order)
select s.id, x.name, x.slug, x.sort_order
from s cross join (values
  ('Septic Basics','septic-basics',10),
  ('Maintenance','maintenance',20),
  ('Problems & Fixes','problems-fixes',30),
  ('Costs & Inspections','costs-inspections',40),
  ('System Types','system-types',50),
  ('Parts & Sizing','parts-sizing',60)
) as x(name,slug,sort_order)
on conflict(site_id,slug) do update set name=excluded.name, sort_order=excluded.sort_order;

with s as (select id from public.sites where domain='septicbeacon.com'),
c as (select id from public.categories where slug='maintenance' and site_id=(select id from s))
insert into public.articles(
  site_id, category_id, title, slug, content_type, status,
  primary_keyword, search_intent, content_markdown,
  seo_title, meta_description, canonical_path, reviewer_required
)
select
  s.id, c.id,
  'How Often Should You Pump Your Septic Tank?',
  'how-often-should-you-pump-your-septic-tank',
  'guide','draft',
  'how often should you pump your septic tank',
  'Help homeowners understand pumping intervals, warning signs, costs, and maintenance factors.',
  'Draft article content.',
  'How Often Should You Pump Your Septic Tank?',
  'Learn how often to pump a septic tank, what changes the schedule, warning signs, and practical maintenance tips.',
  '/blog/how-often-should-you-pump-your-septic-tank',
  false
from s,c
on conflict(site_id,slug) do nothing;
