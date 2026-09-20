# RVFixWise MCP v1

Remote MCP endpoint: `https://rvfixwise.com/mcp`

## Security

The endpoint requires:

```
Authorization: Bearer <MCP_API_KEY>
```

Create `MCP_API_KEY` as a Cloudflare Worker secret. Do not place it in `wrangler.jsonc` or commit it to GitHub.

## Tools

- `site_status`
- `list_categories`
- `list_articles`
- `get_article`
- `create_article` (always creates a draft)
- `update_article` (does not change workflow status)
- `schedule_article` (requires the existing publish gate)
- `publish_article` (explicit user-requested publish only; requires publish gate)

## Architecture

ChatGPT / OpenAI API -> `/mcp` -> Cloudflare Worker -> Supabase CMS.

Scheduling reuses the existing Cloudflare cron and `article_publish_gate`; MCP does not create a second publishing system.

## Cloudflare setup

Add the secret in Cloudflare Workers & Pages -> rvfixwise -> Settings -> Variables and Secrets:

- Name: `MCP_API_KEY`
- Type: Secret
- Value: generate a long random value (32+ bytes recommended)

Redeploy after saving the secret.

## Smoke test

Send a JSON-RPC request to `/mcp` with the Bearer token:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

For the 2026-07-28 protocol, clients may also send `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. The server is intentionally tolerant enough to support the common 2025 initialize/tools flow as well.

## Publishing safety

The MCP layer never bypasses `article_publish_gate`. `create_article` always creates `draft`. Direct publication is exposed only as the explicit `publish_article` tool and should be invoked only after a user specifically requests publishing.
