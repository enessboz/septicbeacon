# SepticBeacon production infrastructure

## Cloudflare Worker
Worker name: `septicbeacon`

Preview Worker: `septicbeacon-preview`

Production domain: `septicbeacon.com`

R2 binding:
- binding: `MEDIA_BUCKET`
- bucket: `septicbeacon-media`

Cron:
- every minute for scheduled publishing

## GitHub Actions secrets

Required for Wrangler deployment from GitHub Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The token should be scoped only to the account/resources required for this Worker deployment.

## Worker secrets / environment

Required by the application:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MCP_API_KEY`

Optional integrations:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GA4_MEASUREMENT_ID`
- `GSC_VERIFICATION`

## Supabase

The application schema is multi-site and mirrors the RVFixWise platform.

Run in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_seed_septicbeacon.sql`
3. `supabase/migrations/003_app_policies_and_publish.sql`
4. project-level migrations `004_functional_v4.sql` through `010_full_rich_demo_article_v5_2.sql` only where their objects are not already present

If SepticBeacon shares the existing RVFixWise Supabase project, do not re-run destructive/base schema operations. Only insert the SepticBeacon site/category seed and any missing additive migrations.

## Admin

Protected path:
`/sb-control-8n4k`

The authenticated user must have a row in `site_members` for the SepticBeacon `site_id`.

## Cutover rule

Do not point `septicbeacon.com` to the Worker until:

- preview build succeeds
- Supabase site row exists
- owner membership exists
- admin login works
- article create/edit/publish works
- scheduled publishing works
- sitemap and robots respond correctly
- public homepage/category/article routes render successfully
