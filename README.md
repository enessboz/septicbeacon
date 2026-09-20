# SepticBeacon Publisher

A small GitHub Actions bridge that publishes JSON jobs to the WordPress REST API at **https://septicbeacon.com**.

## Required GitHub Actions secrets

Add these under **Settings → Secrets and variables → Actions → New repository secret**:

- `WP_USERNAME` — the WordPress username that owns the Application Password.
- `WP_APP_PASSWORD` — the WordPress Application Password. Spaces are accepted.

Never commit either value to this repository.

## Test the connection

Open **Actions → Publish to SepticBeacon → Run workflow**, turn on **Only test the WordPress connection**, and run it.

## Update an existing post

Create a JSON file in `posts/`:

```json
{
  "action": "update",
  "id": 171,
  "expect_slug": "selling-house-with-bad-septic-system",
  "content": "<p>New article HTML...</p>",
  "excerpt": "New excerpt.",
  "status": "publish"
}
```

When the file is committed to `main`, GitHub Actions sends it to the WordPress REST API.

## Create a post

```json
{
  "action": "create",
  "title": "Example title",
  "slug": "example-title",
  "content": "<p>Article HTML...</p>",
  "excerpt": "Example excerpt.",
  "status": "draft",
  "categories": [5]
}
```

## Safety

For updates, use `expect_slug`. The publisher checks the current WordPress slug before writing so an incorrect post ID does not overwrite the wrong article.

SEO plugin fields such as Rank Math metadata may require additional REST exposure in WordPress. Core post publishing works through the standard WordPress REST API.
