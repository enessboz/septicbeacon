-- RVFixWise v4.8
-- Root-level article URLs + rich demo article
-- Run once in Supabase SQL Editor after 007_media_library_v4_7.sql.

do $$
declare
  v_site uuid;
  v_category uuid;
  v_article uuid;
begin
  select id into v_site
  from public.sites
  where domain='rvfixwise.com'
  limit 1;

  if v_site is null then
    raise exception 'RVFixWise site record not found';
  end if;

  select id into v_category
  from public.categories
  where site_id=v_site and slug='plumbing'
  limit 1;

  if v_category is null then
    select id into v_category
    from public.categories
    where site_id=v_site
    order by sort_order nulls last, created_at
    limit 1;
  end if;

  -- All article canonicals now follow /article-slug.
  update public.articles
  set canonical_path='/'||slug
  where site_id=v_site
    and canonical_path is distinct from '/'||slug;

  insert into public.articles (
    site_id, category_id, title, slug, content_type, status,
    primary_keyword, search_intent, excerpt, seo_title, meta_description,
    canonical_path, content_markdown, featured_image_url, featured_image_alt,
    reviewer_required, published_at, first_published_at
  )
  values (
    v_site,
    v_category,
    'RV Water System Troubleshooting: A Complete Demo Guide',
    'rv-water-system-troubleshooting-demo',
    'troubleshooting',
    'published',
    'rv water system troubleshooting',
    'Demonstrate a complete RVFixWise article layout with images, tables, links and CTA blocks.',
    'A demonstration RVFixWise guide showing the complete article experience: featured image, diagnostic table, internal links, inline visuals, lists and CTA blocks.',
    'RV Water System Troubleshooting Demo Guide | RVFixWise',
    'See the full RVFixWise blog layout with a featured image, tables, internal links, inline images, troubleshooting steps and CTA sections.',
    '/rv-water-system-troubleshooting-demo',
    $md$
This is a **demonstration article** created to test the full RVFixWise publishing layout. It shows how a finished guide can combine structured copy, imagery, tables, internal links and clear next steps.

> Safety first: stop if a check involves electrical, propane, structural or pressurized-system work beyond your experience.

## Start with the symptom, not the replacement part

A useful troubleshooting flow begins by defining exactly what the RV is doing. Before replacing a component, compare the symptom with the simplest checks first.

![RV plumbing system illustration](/demo-media/plumbing.webp "Example visual for an RV plumbing section")

| Symptom | First check | Possible direction |
|---|---|---|
| Pump runs but no water arrives | Fresh tank level and valve position | Supply-side or priming issue |
| Water flow is weak | Faucet aerator and inlet strainer | Restriction or partial blockage |
| Pump cycles when taps are closed | Visible leaks and pressure-side fittings | Pressure loss somewhere in the system |
| No pump sound | 12V supply, fuse and switch | Electrical supply or pump circuit |

:::cta Need a broader plumbing checklist? | Browse the Plumbing hub before replacing components. | Explore Plumbing Guides | /category/plumbing

## A practical diagnostic sequence

1. Confirm the symptom at more than one fixture.
2. Check the simplest supply conditions first.
3. Inspect accessible hoses, valves and strainers.
4. Separate plumbing symptoms from possible 12V supply problems.
5. Only move toward component replacement after the basic checks are exhausted.

### Keep the diagnosis organized

A simple notes table can prevent repeated checks:

| Check | Result | Next action |
|---|---|---|
| Fresh tank has water | Pass | Continue |
| Winterization valve position | Pass | Continue |
| Inlet strainer clean | Needs attention | Clean and retest |
| Pump receives 12V | Pass | Continue |

![RV electrical system illustration](/demo-media/electrical.webp "Example inline visual showing that some RV troubleshooting crosses systems")

When a plumbing symptom may involve power, continue with the [Electrical & 12V guides](/category/electrical) rather than guessing at the pump itself.

## Internal linking should help the reader move naturally

Good internal links are not added simply for SEO. They should offer the next useful path. For example:

- Visit the [Plumbing hub](/category/plumbing) for water-system topics.
- Browse [all RV repair guides](/guides) if the symptom is still unclear.
- Use the [Maintenance section](/category/maintenance) for preventive checks.

![RV maintenance illustration](/demo-media/maintenance.webp "A second inline image demonstrating the article image layout")

:::cta Not sure which system is causing the problem? | Search the full RVFixWise guide library by symptom before buying a replacement part. | Search all guides | /search.html

## What this demo page is testing

This published demo intentionally includes:

- A featured image
- Multiple headings
- A safety blockquote
- Ordered and unordered lists
- Two responsive tables
- Internal links
- Multiple inline WebP images
- Image captions
- Two CTA blocks
- Responsive article typography

The article can be deleted after the visual and CMS workflow are approved.
$md$,
    '/demo-media/maintenance.webp',
    'RV maintenance diagnostic illustration',
    false,
    now(),
    now()
  )
  on conflict (site_id,slug) do update set
    category_id=excluded.category_id,
    title=excluded.title,
    content_type=excluded.content_type,
    status='published',
    primary_keyword=excluded.primary_keyword,
    search_intent=excluded.search_intent,
    excerpt=excluded.excerpt,
    seo_title=excluded.seo_title,
    meta_description=excluded.meta_description,
    canonical_path=excluded.canonical_path,
    content_markdown=excluded.content_markdown,
    featured_image_url=excluded.featured_image_url,
    featured_image_alt=excluded.featured_image_alt,
    published_at=coalesce(public.articles.published_at,now()),
    first_published_at=coalesce(public.articles.first_published_at,now()),
    updated_at=now()
  returning id into v_article;

  delete from public.internal_links where source_article_id=v_article;
  insert into public.internal_links(site_id,source_article_id,anchor_text,target_path)
  values
    (v_site,v_article,'Plumbing hub','/category/plumbing'),
    (v_site,v_article,'Electrical & 12V guides','/category/electrical'),
    (v_site,v_article,'all RV repair guides','/guides'),
    (v_site,v_article,'Maintenance section','/category/maintenance');
end $$;
