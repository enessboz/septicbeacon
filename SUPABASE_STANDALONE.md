# SepticBeacon — Standalone Supabase

SepticBeacon should use its own Supabase project. RVFixWise and SepticBeacon may share application architecture, but they should not share database/auth/storage state.

## Bootstrap order

Run these SQL files in the new SepticBeacon Supabase project's SQL Editor in this order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/003_app_policies_and_publish.sql`
3. `004_functional_v4.sql`
4. `005_gsc_setup_v4_2.sql`
5. `006_site_identity_center_v4_3.sql`
6. `007_media_library_v4_7.sql`
7. `supabase/migrations/002_seed_septicbeacon.sql`

Do not run RVFixWise/demo-specific migrations 008–010 in the standalone SepticBeacon project.

## Cloudflare Worker values

After the new Supabase project is created, update the SepticBeacon Worker only:

- `SUPABASE_URL` → new SepticBeacon project URL
- `SUPABASE_ANON_KEY` → new SepticBeacon publishable/anon key
- `SUPABASE_SERVICE_ROLE_KEY` → new SepticBeacon service-role/secret key

Keep these values isolated from RVFixWise.

## Admin user

Create the SepticBeacon admin user in the new project's Auth section. Then insert an owner membership into `site_members` for the SepticBeacon site row.

## Content migration

The current smoke-test article may be recreated in the standalone project after cutover. No RVFixWise article/content rows should be copied.

## Cutover checklist

Before changing production Worker env:

- schema and policies applied
- SepticBeacon site seed exists
- six categories exist
- admin Auth user exists
- owner membership exists
- public article read works
- admin login works
- create/edit/publish works

Only then replace the Worker Supabase env values and deploy.
