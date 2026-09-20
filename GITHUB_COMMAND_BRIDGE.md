# RVFixWise GitHub Command Bridge

This bridge lets ChatGPT create a GitHub issue that GitHub Actions executes against the RVFixWise MCP server.

## Trigger

Create an issue with a title beginning exactly with:

`[RVFIXWISE COMMAND]`

Only issues created by GitHub user `enessboz` are accepted.

## Required repository secret

GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret

- Name: `RVFIXWISE_MCP_KEY`
- Value: the same value stored in Cloudflare as `MCP_API_KEY`

Never put the key in an issue, commit, or workflow file.

## Issue body format

```json
{
  "action": "create_article",
  "arguments": {
    "title": "Example",
    "category_slug": "maintenance",
    "content_type": "guide",
    "primary_keyword": "example",
    "search_intent": "informational",
    "seo_title": "Example",
    "meta_description": "Example description",
    "content_markdown": "# Example\n\nContent"
  }
}
```

Supported actions:
- `site_status`
- `list_categories`
- `list_articles`
- `get_article`
- `create_article`
- `update_article`
- `schedule_article`
- `publish_article`

For direct publishing, the root command must also contain:

```json
"confirm_publish": true
```

The Action posts the MCP result back to the issue and closes successful commands.
