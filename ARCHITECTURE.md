# RVFixWise System Architecture v1

## Core decision

RVFixWise is a **Cloudflare-first content platform** with Supabase as its data/auth layer. ChatGPT Work is the main content-production interface for the first phase; there is no OpenAI API dependency in 1.0.

### Runtime

```text
Visitor
  ↓
Cloudflare DNS / CDN
  ↓
Cloudflare Workers
  ↓
Next.js / vinext application
  ├── Public site
  └── /admin
        ↓
     Supabase Auth
        ↓
     Supabase Postgres
```

Cloudflare's current Next.js guide recommends **vinext** as the default approach for new Next.js applications on Workers. The project should therefore avoid Vercel-specific APIs and assumptions.

## Content workflow

```text
Topic Map / GSC Opportunity
        ↓
Content Calendar
        ↓
ChatGPT Work researches + writes
        ↓
Quick Entry
  title
  keyword
  category
  SEO fields
  full Markdown
  sources
  internal links
  image brief
        ↓
CMS validation / Publish Gate
        ↓
Editorial QA
        ↓
Technical review when required
        ↓
Published
        ↓
GSC + GA4 monitoring
        ↓
Opportunity / Alert / Refresh Queue
```

The master editing format is `articles.content_markdown`. `content_blocks` is a derived/rendering representation, not the source of truth. That makes ChatGPT Work entry fast and prevents the browser automation from having to create many individual CMS blocks.

## Main table groups

### Identity and access
- `sites`
- `profiles`
- `site_members`

Even though 1.0 contains only RVFixWise, nearly every operational record has a `site_id`. This avoids a painful migration if the same platform later runs additional sites.

### Publishing
- `categories`
- `people`
- `articles`
- `article_revisions`
- `article_sources`
- `internal_links`
- `media`

### SEO operations
- `topic_keywords`
- `content_calendar`
- `gsc_daily`
- `gsc_url_inspections`
- `ga4_daily`
- `seo_opportunities`
- `crawl_runs`
- `crawl_urls`
- `alerts`
- `redirects`

### Background / integrations
- `jobs`
- `integrations`
- `sync_runs`

## Important design rules

1. **Markdown is the editorial source of truth.**
   The application parses it into TOC, Article sections, FAQ presentation, tables and schema-ready structures.

2. **Sources are separate relational records.**
   Do not bury source URLs only inside Markdown. This allows validation, source counts, broken-source checks and reviewer workflows.

3. **Internal links are stored separately.**
   The graph can then calculate incoming links, outgoing links, orphan risk and suggestions.

4. **Reviewer state is explicit.**
   `reviewer_required = true` blocks publish until `reviewer_completed_at` exists.

5. **GSC raw-ish daily dimensions are retained.**
   Query/page/country/device data enables later opportunity logic without re-requesting everything from Google.

6. **External OAuth tokens must not live in normal `integrations.config`.**
   Store sensitive credentials in a server-side secret store / Supabase Vault or Cloudflare Secrets. Only non-secret property IDs/config belong in the database.

7. **RLS is mandatory.**
   Supabase currently recommends RLS plus explicit grants for exposed schemas. `service_role` must stay server-side only.

## Publish gate

The provided migration creates `article_publish_gate`. The actual production publish action should:

1. read the gate,
2. reject `published` if `can_publish = false`,
3. snapshot the current revision,
4. set `published_at`,
5. set `first_published_at` only once,
6. enqueue revalidation/sitemap/internal-link checks.

The gate currently verifies:
- usable title
- sufficiently long body
- SEO title
- meta description
- canonical
- at least one source
- at least one internal link
- reviewer completion when required

We can tighten these rules after real editorial testing.

## RLS plan

Initial roles:
- `owner`
- `admin`
- `editor`
- `reviewer`
- `viewer`

Recommended write scope:
- Owner/Admin: all CMS mutations
- Editor: articles, sources, links, topic map, calendar
- Reviewer: review-related updates only
- Viewer: read-only admin dashboards

The migration includes the security foundation and complete policies for `articles`. Remaining tables should receive explicit per-operation policies during implementation rather than one giant permissive policy.

## GSC / GA4 synchronization

### GSC
Scheduled server job:
- performance data: daily
- recent performance window: refresh last 3–7 days to account for late data
- sitemap status: daily
- URL Inspection: selective, not a full-site live test

### GA4
Scheduled server job:
- landing-page metrics daily
- refresh recent days
- keep aggregate reporting tables in Postgres for fast dashboards

## Background jobs

1.0 can use the `jobs` table plus a Cloudflare scheduled Worker.

Later, if needed:
- Supabase Queues for pull-based job processing
- Supabase Cron for DB-centric scheduled jobs
- Cloudflare Queues for Cloudflare-native workloads

Do not add a queue system until workload requires it.

## Media

Preferred production media path:

```text
ChatGPT Work / admin upload
        ↓
Cloudflare R2
        ↓
media table stores object key + metadata
        ↓
Cloudflare CDN
```

Supabase Storage can also work, but using R2 keeps media traffic in the Cloudflare layer.

## What is intentionally NOT in 1.0

- automatic AI publishing
- complex multi-tenant billing
- public user accounts
- comments/community
- advanced AdSense experiments
- full enterprise workflow engine
- unnecessary microservices

## Implementation sequence

1. Create Supabase project.
2. Run `001_initial_schema.sql`.
3. Run `002_seed_rvfixwise.sql`.
4. Create first Auth user.
5. Insert that user into `profiles` and `site_members` as `owner`.
6. Scaffold Cloudflare Workers-compatible Next.js application.
7. Connect Supabase SSR/Auth.
8. Implement `/admin/login`.
9. Implement Quick Entry CRUD.
10. Implement Markdown renderer.
11. Implement publish gate.
12. Implement public article/category routes.
13. Add GSC sync.
14. Add GA4 sync.
15. Add crawl + opportunity jobs.
16. Connect R2 media.
17. Production QA and Cloudflare deploy.

## Work automation contract

ChatGPT Work only needs one stable page for normal article creation: `/admin/content/new`.

The browser form should use predictable field labels and IDs:

- `title`
- `slug`
- `content_type`
- `category`
- `primary_keyword`
- `search_intent`
- `seo_title`
- `meta_description`
- `canonical_path`
- `content_markdown`
- `sources_text`
- `internal_links_text`
- `featured_image_prompt`
- `featured_image_alt`
- `reviewer_required`

Buttons:
- `Save Draft`
- `Run Checks`
- `Send to Editorial QA`

No modal should be required for normal content creation.
