import fs from "node:fs";

const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const issue = event.issue;
const repo = event.repository?.full_name;
const token = process.env.GITHUB_TOKEN;
const mcpKey = process.env.SEPTICBEACON_MCP_KEY;

function fail(message) {
  throw new Error(message);
}

if (!issue || !repo) fail("Issue event payload is missing.");
if (!token) fail("GITHUB_TOKEN is missing.");
if (!mcpKey) fail("SEPTICBEACON_MCP_KEY is missing. Add it in GitHub repository Actions secrets.");

if (issue.user?.login !== "enessboz") {
  fail("Only commands created by the repository owner are allowed.");
}
if (!String(issue.title || "").startsWith("[SEPTICBEACON COMMAND]")) {
  fail("Issue title is not an SepticBeacon command.");
}

function extractJson(body) {
  const text = String(body || "").trim();
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i);
  const source = fenced ? fenced[1] : text;
  return JSON.parse(source);
}

const command = extractJson(issue.body);
const action = command.action;
const args = command.arguments ?? {};

const allowed = new Set([
  "site_status",
  "list_categories",
  "list_articles",
  "get_article",
  "create_article",
  "update_article",
  "import_media_from_url",
  "add_article_image",
  "generate_article_image",
  "set_article_relations",
  "schedule_article",
  "publish_article"
]);

if (!allowed.has(action)) fail(`Unsupported action: ${action}`);
if (typeof args !== "object" || Array.isArray(args) || args === null) fail("arguments must be a JSON object.");

if (action === "publish_article" && command.confirm_publish !== true) {
  fail("publish_article requires confirm_publish: true.");
}

async function github(path, options = {}) {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function comment(body) {
  return github(`/issues/${issue.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body })
  });
}

async function closeIssue() {
  return github(`/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" })
  });
}

try {
  await comment(`🚀 SepticBeacon command started: **${action}**`);

  const rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: action, arguments: args }
  };

  const response = await fetch("https://septicbeacon.com/mcp", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${mcpKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(rpc)
  });

  const raw = await response.text();
  if (!response.ok) fail(`MCP HTTP ${response.status}: ${raw}`);

  let data;
  try { data = JSON.parse(raw); }
  catch { fail(`MCP returned invalid JSON: ${raw.slice(0,1000)}`); }

  if (data.error) fail(`MCP RPC error: ${JSON.stringify(data.error)}`);
  const result = data.result;
  const isError = result?.isError === true;
  const pretty = JSON.stringify(result, null, 2).slice(0, 60000);

  await comment(
    `${isError ? "❌" : "✅"} SepticBeacon command finished: **${action}**\n\n\`\`\`json\n${pretty}\n\`\`\``
  );

  if (isError) process.exitCode = 1;
  else await closeIssue();
} catch (err) {
  const message = err?.stack || err?.message || String(err);
  try {
    await comment(`❌ SepticBeacon command failed.\n\n\`\`\`text\n${message.slice(0,60000)}\n\`\`\``);
  } catch {}
  throw err;
}
