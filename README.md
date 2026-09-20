# SepticBeacon

Custom Cloudflare Worker + Supabase publishing platform for [septicbeacon.com](https://septicbeacon.com).

## Architecture

- Cloudflare Worker: routing, SSR injection, security headers, cron publishing
- Cloudflare static assets: public frontend + protected admin UI
- Supabase: sites, articles, categories, auth, workflow, revisions, SEO/integration data
- Cloudflare R2: article media
- GitHub Actions: validation and production deploy
- Admin: `/sb-control-8n4k`
- Public article routes: `/blog/{slug}`
- Public category routes: `/category/{slug}`

## Editorial workflow

Draft → Editorial QA → Technical Review → Ready → Scheduled/Published.

## SepticBeacon taxonomy

- Septic Basics
- Maintenance
- Problems & Fixes
- Costs & Inspections
- System Types
- Parts & Sizing

The platform is derived from the RVFixWise application architecture, while its public design, taxonomy, content and brand are SepticBeacon-specific.

The legacy WordPress publisher files are retained temporarily for historical reference only. The WordPress publishing workflow is disabled on the platform rebuild branch.
