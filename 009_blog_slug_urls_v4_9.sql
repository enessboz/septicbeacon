-- RVFixWise v4.9 URL migration
-- Run once in Supabase SQL Editor after deployment.

update public.articles
set canonical_path='/blog/'||slug,
    updated_at=now()
where site_id=(select id from public.sites where domain='rvfixwise.com' limit 1)
  and canonical_path is distinct from '/blog/'||slug;

-- Update the rich demo article too if it exists.
update public.articles
set canonical_path='/blog/'||slug
where slug='rv-water-system-troubleshooting-demo';
