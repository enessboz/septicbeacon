import { MEDIA_TOOLS, importMediaFromUrl, addArticleImage, generateArticleImage } from "./mcp-media.js";
// SepticBeacon remote MCP server (stateless HTTP)
// Supports current MCP 2026-07-28 requests and the common 2025 initialize/tools flow.
// Authentication: OAuth 2.1 access token (Claude) or direct Bearer MCP_API_KEY for admin testing.

const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

const TOOLS = [
  ...MEDIA_TOOLS,
  {
    name: "site_status",
    title: "SepticBeacon site status",
    description: "Check that the SepticBeacon MCP server can reach the CMS database and return basic content counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "list_categories",
    title: "List SepticBeacon categories",
    description: "List active SepticBeacon content categories with their IDs, names and slugs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "list_articles",
    title: "List SepticBeacon articles",
    description: "List SepticBeacon articles. Optionally filter by workflow status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["idea","brief","draft","editorial_qa","technical_review","ready","scheduled","published","refresh","archived"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_article",
    title: "Get an SepticBeacon article",
    description: "Get one SepticBeacon article by id or slug, including markdown, SEO fields and workflow status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        slug: { type: "string" }
      },
      oneOf: [{ required: ["id"] }, { required: ["slug"] }],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_article",
    title: "Create SepticBeacon draft",
    description: "Create a new SepticBeacon article as a draft. This never publishes automatically.",
    inputSchema: {
      type: "object",
      required: ["title","category_slug","primary_keyword","search_intent","seo_title","meta_description","content_markdown"],
      properties: {
        title: { type: "string", minLength: 3 },
        slug: { type: "string" },
        category_slug: { type: "string", minLength: 1 },
        content_type: { type: "string", enum: ["troubleshooting","how_to","maintenance","best","comparison","guide","hub"], default: "guide" },
        primary_keyword: { type: "string", minLength: 1 },
        search_intent: { type: "string", minLength: 1 },
        seo_title: { type: "string", minLength: 1 },
        meta_description: { type: "string", minLength: 1 },
        content_markdown: { type: "string", minLength: 1 },
        excerpt: { type: "string" },
        quick_answer: { type: "string" },
        canonical_path: { type: "string" },
        featured_image_url: { type: "string" },
        featured_image_alt: { type: "string" },
        featured_image_prompt: { type: "string" },
        reviewer_required: { type: "boolean", default: true }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "update_article",
    title: "Update SepticBeacon article",
    description: "Update editable SepticBeacon article fields without changing its workflow status.",
    inputSchema: {
      type: "object",
      required: ["id","changes"],
      properties: {
        id: { type: "string" },
        changes: {
          type: "object",
          properties: {
            title: { type: "string" },
            slug: { type: "string" },
            category_slug: { type: "string" },
            content_type: { type: "string", enum: ["troubleshooting","how_to","maintenance","best","comparison","guide","hub"] },
            primary_keyword: { type: "string" },
            search_intent: { type: "string" },
            seo_title: { type: "string" },
            meta_description: { type: "string" },
            content_markdown: { type: "string" },
            excerpt: { type: "string" },
            quick_answer: { type: "string" },
            canonical_path: { type: "string" },
            featured_image_url: { type: "string" },
            featured_image_alt: { type: "string" },
            featured_image_prompt: { type: "string" },
            reviewer_required: { type: "boolean" }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "set_article_relations",
    title: "Set SepticBeacon article sources and internal links",
    description: "Replace an article's source references and registered internal links used by the publish gate.",
    inputSchema: {
      type: "object",
      required: ["id","sources","internal_links"],
      properties: {
        id: { type: "string" },
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["label","url"],
            properties: {
              label: { type: "string" },
              url: { type: "string" },
              source_type: { type: "string" }
            },
            additionalProperties: false
          }
        },
        internal_links: {
          type: "array",
          items: {
            type: "object",
            required: ["anchor_text","target_path"],
            properties: {
              anchor_text: { type: "string" },
              target_path: { type: "string" }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "schedule_article",
    title: "Schedule SepticBeacon article",
    description: "Schedule an article for publishing. The existing SepticBeacon publish gate must pass before scheduling, and the existing Cloudflare cron performs the publication.",
    inputSchema: {
      type: "object",
      required: ["id","scheduled_at"],
      properties: {
        id: { type: "string" },
        scheduled_at: { type: "string", description: "ISO 8601 timestamp with timezone, for example 2026-09-25T10:00:00+03:00" }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "publish_article",
    title: "Publish SepticBeacon article",
    description: "Explicitly publish an article now only when the SepticBeacon publish gate passes. Use only when the user specifically requests publication.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function jsonRpc(id, result, status=200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": PROTOCOL_VERSION
    }
  });
}

function rpcError(id, code, message, data, status=200) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": PROTOCOL_VERSION
    }
  });
}

function toolResult(value, isError=false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof value === "object" && value !== null ? value : { result: value },
    isError
  };
}


const OAUTH_ISSUER = "https://septicbeacon.com";
const OAUTH_RESOURCE = "https://septicbeacon.com/mcp";

function b64urlEncodeBytes(bytes){
  let binary="";
  for(const b of bytes)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function b64urlEncodeText(text){
  return b64urlEncodeBytes(new TextEncoder().encode(text));
}
function b64urlDecodeText(value){
  const padded=String(value).replace(/-/g,"+").replace(/_/g,"/")+"===".slice((String(value).length+3)%4);
  const binary=atob(padded);
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
async function hmacKey(env){
  const secret=String(env.MCP_API_KEY||"").trim();
  if(!secret)throw new Error("MCP_API_KEY is not configured.");
  return crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
async function signEnvelope(env,payload){
  const body=b64urlEncodeText(JSON.stringify(payload));
  const sig=await crypto.subtle.sign("HMAC",await hmacKey(env),new TextEncoder().encode(body));
  return body+"."+b64urlEncodeBytes(new Uint8Array(sig));
}
async function verifyEnvelope(env,token,expectedType){
  try{
    const [body,sigPart,...rest]=String(token||"").split(".");
    if(!body||!sigPart||rest.length)return null;
    const padded=sigPart.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((sigPart.length+3)%4);
    const raw=atob(padded);
    const sig=Uint8Array.from(raw,c=>c.charCodeAt(0));
    const ok=await crypto.subtle.verify("HMAC",await hmacKey(env),sig,new TextEncoder().encode(body));
    if(!ok)return null;
    const payload=JSON.parse(b64urlDecodeText(body));
    if(expectedType&&payload.typ!==expectedType)return null;
    if(payload.exp&&Date.now()>Number(payload.exp)*1000)return null;
    return payload;
  }catch{return null}
}
async function sha256Base64url(value){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));
  return b64urlEncodeBytes(new Uint8Array(digest));
}
function oauthJson(value,status=200,extra={}){
  return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extra}});
}
function oauthError(error,description,status=400){
  return oauthJson({error,error_description:description},status);
}
function htmlEscape(value){
  return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function allowedRedirect(uri){
  try{
    const u=new URL(uri);
    if(u.protocol==="https:")return true;
    return u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname);
  }catch{return false}
}
async function verifyClient(env,clientId){
  return verifyEnvelope(env,clientId,"client");
}
async function authorized(request, env) {
  const expected = String(env.MCP_API_KEY || "").trim();
  if (!expected) return { ok: false, status: 503, message: "MCP_API_KEY is not configured." };
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+/i.test(auth)) return { ok: false, status: 401, message: "Unauthorized" };
  const token=auth.replace(/^Bearer\s+/i,"").trim();
  if(token===expected)return {ok:true,mode:"direct"};
  const access=await verifyEnvelope(env,token,"access");
  if(!access||access.aud!==OAUTH_RESOURCE)return { ok: false, status: 401, message: "Unauthorized" };
  return { ok: true, mode:"oauth", scope:access.scope||"mcp" };
}

async function oauthRegister(request,env){
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  let body={};
  try{body=await request.json()}catch{return oauthError("invalid_client_metadata","Invalid JSON body.")}
  const redirects=Array.isArray(body.redirect_uris)?body.redirect_uris.filter(Boolean):[];
  if(!redirects.length||redirects.some(x=>!allowedRedirect(x)))return oauthError("invalid_redirect_uri","At least one valid HTTPS redirect URI is required.");
  const now=Math.floor(Date.now()/1000);
  const clientId=await signEnvelope(env,{
    typ:"client",iat:now,exp:now+31536000,
    redirect_uris:redirects,
    client_name:String(body.client_name||"Claude").slice(0,120),
    application_type:String(body.application_type||"web")
  });
  return oauthJson({
    client_id:clientId,
    client_id_issued_at:now,
    client_name:String(body.client_name||"Claude"),
    redirect_uris:redirects,
    application_type:String(body.application_type||"web"),
    token_endpoint_auth_method:"none",
    grant_types:["authorization_code"],
    response_types:["code"]
  },201);
}

async function oauthAuthorize(request,env){
  const params=request.method==="POST"
    ? new URLSearchParams(await request.text())
    : new URL(request.url).searchParams;
  const clientId=params.get("client_id")||"";
  const redirectUri=params.get("redirect_uri")||"";
  const responseType=params.get("response_type")||"";
  const state=params.get("state")||"";
  const codeChallenge=params.get("code_challenge")||"";
  const codeMethod=params.get("code_challenge_method")||"";
  const scope=params.get("scope")||"mcp";
  const resource=params.get("resource")||OAUTH_RESOURCE;
  const client=await verifyClient(env,clientId);
  if(!client)return oauthError("invalid_request","Unknown or expired OAuth client.");
  if(responseType!=="code")return oauthError("unsupported_response_type","Only authorization code flow is supported.");
  if(!client.redirect_uris?.includes(redirectUri)||!allowedRedirect(redirectUri))return oauthError("invalid_request","redirect_uri is not registered for this client.");
  if(!codeChallenge||codeMethod!=="S256")return oauthError("invalid_request","PKCE S256 is required.");
  if(resource!==OAUTH_RESOURCE)return oauthError("invalid_target","This authorization server only grants access to the SepticBeacon MCP resource.");

  if(request.method==="GET"){
    const hidden=[["client_id",clientId],["redirect_uri",redirectUri],["response_type",responseType],["state",state],["code_challenge",codeChallenge],["code_challenge_method",codeMethod],["scope",scope],["resource",resource]]
      .map(([k,v])=>`<input type="hidden" name="${k}" value="${htmlEscape(v)}">`).join("");
    const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect SepticBeacon</title><style>body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(460px,calc(100vw - 40px));background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 24px 70px #0008}h1{margin:0 0 8px;font-size:24px}p{color:#94a3b8;line-height:1.5}label{display:block;margin:22px 0 8px;font-weight:650}input[type=password]{width:100%;box-sizing:border-box;border:1px solid #475569;background:#020617;color:#fff;border-radius:10px;padding:12px 14px;font-size:15px}button{width:100%;margin-top:16px;border:0;border-radius:10px;padding:12px 16px;font-size:15px;font-weight:700;cursor:pointer;background:#f59e0b;color:#111827}.small{font-size:12px}</style></head><body><form class="card" method="post" action="/oauth/authorize"><h1>Connect SepticBeacon to Claude</h1><p>Claude is requesting access to your SepticBeacon CMS connector. Enter the same secret value you saved in Cloudflare as <strong>MCP_API_KEY</strong>.</p>${hidden}<label for="connector_key">Connector key</label><input id="connector_key" name="connector_key" type="password" autocomplete="off" required><button type="submit">Authorize Claude</button><p class="small">The key is verified by SepticBeacon and is not sent to Claude.</p></form></body></html>`;
    return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Frame-Options":"DENY"}});
  }

  const submitted=params.get("connector_key")||"";
  if(submitted!==String(env.MCP_API_KEY||"").trim())return new Response("<h2>Invalid connector key.</h2><p>Go back and try again.</p>",{status:401,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
  const now=Math.floor(Date.now()/1000);
  const code=await signEnvelope(env,{typ:"code",iat:now,exp:now+300,client_id:clientId,redirect_uri:redirectUri,code_challenge:codeChallenge,scope,resource});
  const target=new URL(redirectUri);
  target.searchParams.set("code",code);
  if(state)target.searchParams.set("state",state);
  target.searchParams.set("iss",OAUTH_ISSUER);
  return Response.redirect(target.toString(),302);
}

async function oauthToken(request,env){
  if(request.method!=="POST")return new Response("Method not allowed",{status:405});
  const params=new URLSearchParams(await request.text());
  if(params.get("grant_type")!=="authorization_code")return oauthError("unsupported_grant_type","Only authorization_code is supported.");
  const code=params.get("code")||"";
  const clientId=params.get("client_id")||"";
  const redirectUri=params.get("redirect_uri")||"";
  const verifier=params.get("code_verifier")||"";
  const payload=await verifyEnvelope(env,code,"code");
  if(!payload)return oauthError("invalid_grant","Authorization code is invalid or expired.");
  if(payload.client_id!==clientId||payload.redirect_uri!==redirectUri)return oauthError("invalid_grant","Authorization code does not match this client or redirect URI.");
  const client=await verifyClient(env,clientId);
  if(!client||!client.redirect_uris?.includes(redirectUri))return oauthError("invalid_client","Client validation failed.",401);
  if(!verifier||await sha256Base64url(verifier)!==payload.code_challenge)return oauthError("invalid_grant","PKCE verification failed.");
  const now=Math.floor(Date.now()/1000);
  const expiresIn=30*24*60*60;
  const accessToken=await signEnvelope(env,{typ:"access",iat:now,exp:now+expiresIn,aud:OAUTH_RESOURCE,scope:payload.scope||"mcp",client_id:clientId});
  return oauthJson({access_token:accessToken,token_type:"Bearer",expires_in:expiresIn,scope:payload.scope||"mcp"});
}

export async function handleOAuth(request,env,clean){
  if(clean==="/.well-known/oauth-protected-resource"||clean==="/.well-known/oauth-protected-resource/mcp"){
    return oauthJson({
      resource:OAUTH_RESOURCE,
      authorization_servers:[OAUTH_ISSUER],
      scopes_supported:["mcp"],
      bearer_methods_supported:["header"]
    });
  }
  if(clean==="/.well-known/oauth-authorization-server"){
    return oauthJson({
      issuer:OAUTH_ISSUER,
      authorization_endpoint:OAUTH_ISSUER+"/oauth/authorize",
      token_endpoint:OAUTH_ISSUER+"/oauth/token",
      registration_endpoint:OAUTH_ISSUER+"/oauth/register",
      response_types_supported:["code"],
      grant_types_supported:["authorization_code"],
      code_challenge_methods_supported:["S256"],
      token_endpoint_auth_methods_supported:["none"],
      scopes_supported:["mcp"]
    });
  }
  if(clean==="/oauth/register")return oauthRegister(request,env);
  if(clean==="/oauth/authorize")return oauthAuthorize(request,env);
  if(clean==="/oauth/token")return oauthToken(request,env);
  return new Response("Not found",{status:404});
}

function serviceHeaders(env, extra={}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...extra
  };
  if (String(key || "").startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function siteId(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase service credentials are not configured.");
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/sites?domain=eq.septicbeacon.com&select=id&limit=1`, { headers: serviceHeaders(env) });
  if (!r.ok) throw new Error(await r.text());
  const row = (await r.json())[0];
  if (!row?.id) throw new Error("SepticBeacon site record not found.");
  return row.id;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function validIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

async function categoryBySlug(env, site, slug) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/categories?site_id=eq.${site}&slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=id,name,slug&limit=1`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}

async function articleById(env, site, id) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${site}&id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}

async function articleGate(env, id) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/article_publish_gate?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}

async function listCategories(env) {
  const site = await siteId(env);
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/categories?site_id=eq.${site}&is_active=eq.true&select=id,name,slug,description,sort_order&order=sort_order.asc,name.asc`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return { categories: await r.json() };
}

async function listArticles(env, args={}) {
  const site = await siteId(env);
  const limit = Math.min(100, Math.max(1, Number(args.limit || 25)));
  const status = args.status ? `&status=eq.${encodeURIComponent(args.status)}` : "";
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${site}${status}&select=id,title,slug,status,content_type,primary_keyword,seo_title,scheduled_at,published_at,updated_at,category_id&order=updated_at.desc&limit=${limit}`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return { articles: await r.json() };
}

async function getArticle(env, args={}) {
  const site = await siteId(env);
  let filter;
  if (args.id) filter = `id=eq.${encodeURIComponent(args.id)}`;
  else if (args.slug) filter = `slug=eq.${encodeURIComponent(args.slug)}`;
  else throw new Error("Provide id or slug.");
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${site}&${filter}&select=*,categories(id,name,slug)&limit=1`,
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  const article = (await r.json())[0];
  if (!article) throw new Error("Article not found.");
  return { article };
}

async function createArticle(env, args={}) {
  const site = await siteId(env);
  const category = await categoryBySlug(env, site, args.category_slug);
  if (!category) throw new Error(`Category not found: ${args.category_slug}`);

  const slug = slugify(args.slug || args.title);
  if (!slug) throw new Error("Could not generate a valid slug.");

  const payload = {
    site_id: site,
    category_id: category.id,
    title: String(args.title).trim(),
    slug,
    content_type: args.content_type || "guide",
    status: "draft",
    primary_keyword: String(args.primary_keyword).trim(),
    search_intent: String(args.search_intent).trim(),
    seo_title: String(args.seo_title).trim(),
    meta_description: String(args.meta_description).trim(),
    content_markdown: String(args.content_markdown),
    excerpt: args.excerpt ? String(args.excerpt).trim() : null,
    quick_answer: args.quick_answer ? String(args.quick_answer).trim() : null,
    canonical_path: args.canonical_path ? String(args.canonical_path).trim() : `/blog/${slug}`,
    featured_image_url: args.featured_image_url ? String(args.featured_image_url).trim() : null,
    featured_image_alt: args.featured_image_alt ? String(args.featured_image_alt).trim() : null,
    featured_image_prompt: args.featured_image_prompt ? String(args.featured_image_prompt).trim() : null,
    reviewer_required: args.reviewer_required !== false
  };

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/articles?select=*`, {
    method: "POST",
    headers: serviceHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Article creation failed.");
  return { ok: true, article: JSON.parse(text)[0], note: "Created as draft; not published." };
}

async function updateArticle(env, args={}) {
  const site = await siteId(env);
  const existing = await articleById(env, site, args.id);
  if (!existing) throw new Error("Article not found.");
  const changes = args.changes || {};
  const allowed = [
    "title","slug","content_type","primary_keyword","search_intent","seo_title","meta_description",
    "content_markdown","excerpt","quick_answer","canonical_path","featured_image_url",
    "featured_image_alt","featured_image_prompt","reviewer_required"
  ];
  const patch = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) patch[key] = changes[key];
  }
  if (changes.category_slug) {
    const category = await categoryBySlug(env, site, changes.category_slug);
    if (!category) throw new Error(`Category not found: ${changes.category_slug}`);
    patch.category_id = category.id;
  }
  if (patch.slug) patch.slug = slugify(patch.slug);
  patch.updated_at = new Date().toISOString();
  if (!Object.keys(patch).length) throw new Error("No editable changes were provided.");

  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?id=eq.${encodeURIComponent(args.id)}&site_id=eq.${site}&select=*`,
    {
      method: "PATCH",
      headers: serviceHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify(patch)
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Article update failed.");
  return { ok: true, article: JSON.parse(text)[0] };
}

async function setArticleRelations(env, args={}) {
  const site = await siteId(env);
  const article = await articleById(env, site, args.id);
  if (!article) throw new Error("Article not found.");

  const sources = Array.isArray(args.sources) ? args.sources : [];
  const links = Array.isArray(args.internal_links) ? args.internal_links : [];

  const delSources = await fetch(
    env.SUPABASE_URL + "/rest/v1/article_sources?article_id=eq." + encodeURIComponent(article.id),
    { method: "DELETE", headers: serviceHeaders(env, { Prefer: "return=minimal" }) }
  );
  if (!delSources.ok) throw new Error(await delSources.text());

  const delLinks = await fetch(
    env.SUPABASE_URL + "/rest/v1/internal_links?source_article_id=eq." + encodeURIComponent(article.id),
    { method: "DELETE", headers: serviceHeaders(env, { Prefer: "return=minimal" }) }
  );
  if (!delLinks.ok) throw new Error(await delLinks.text());

  if (sources.length) {
    const payload = sources.map((s, i) => ({
      article_id: article.id,
      label: String(s.label || "").trim(),
      url: String(s.url || "").trim() || null,
      source_type: String(s.source_type || "reference").trim() || "reference",
      sort_order: i
    })).filter(s => s.label && s.url);
    if (payload.length) {
      const r = await fetch(env.SUPABASE_URL + "/rest/v1/article_sources", {
        method: "POST",
        headers: serviceHeaders(env, { Prefer: "return=minimal" }),
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(await r.text());
    }
  }

  if (links.length) {
    const payload = links.map(l => ({
      site_id: site,
      source_article_id: article.id,
      anchor_text: String(l.anchor_text || "").trim(),
      target_path: String(l.target_path || "").trim(),
      is_live: true
    })).filter(l => l.anchor_text && l.target_path.startsWith("/"));
    if (payload.length) {
      const r = await fetch(env.SUPABASE_URL + "/rest/v1/internal_links", {
        method: "POST",
        headers: serviceHeaders(env, { Prefer: "return=minimal" }),
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error(await r.text());
    }
  }

  return {
    ok: true,
    article_id: article.id,
    sources_count: sources.length,
    internal_links_count: links.length
  };
}

async function scheduleArticle(env, args={}) {
  const site = await siteId(env);
  const existing = await articleById(env, site, args.id);
  if (!existing) throw new Error("Article not found.");
  if (!validIsoDate(args.scheduled_at)) throw new Error("scheduled_at must be a valid ISO 8601 timestamp.");
  if (Date.parse(args.scheduled_at) <= Date.now()) throw new Error("scheduled_at must be in the future.");

  const gate = await articleGate(env, args.id);
  if (!gate?.can_publish) {
    return { ok: false, scheduled: false, reason: "Publish gate failed.", gate };
  }

  const scheduledAt = new Date(args.scheduled_at).toISOString();
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?id=eq.${encodeURIComponent(args.id)}&site_id=eq.${site}&select=id,title,slug,status,scheduled_at`,
    {
      method: "PATCH",
      headers: serviceHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify({ status: "scheduled", scheduled_at: scheduledAt, updated_at: new Date().toISOString() })
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Scheduling failed.");
  return { ok: true, article: JSON.parse(text)[0], note: "Existing Cloudflare cron will publish when due, subject to the publish gate." };
}

async function publishArticle(env, args={}) {
  const site = await siteId(env);
  const existing = await articleById(env, site, args.id);
  if (!existing) throw new Error("Article not found.");
  if (existing.status === "published") return { ok: true, article: existing, note: "Article is already published." };

  const gate = await articleGate(env, args.id);
  if (!gate?.can_publish) {
    return { ok: false, published: false, reason: "Publish gate failed.", gate };
  }

  const now = new Date().toISOString();
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?id=eq.${encodeURIComponent(args.id)}&site_id=eq.${site}&select=id,title,slug,status,published_at,first_published_at`,
    {
      method: "PATCH",
      headers: serviceHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify({
        status: "published",
        published_at: now,
        first_published_at: existing.first_published_at || now,
        scheduled_at: null,
        updated_at: now
      })
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Publish failed.");

  await fetch(`${env.SUPABASE_URL}/rest/v1/jobs`, {
    method: "POST",
    headers: serviceHeaders(env, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      site_id: site,
      article_id: args.id,
      job_type: "post_publish",
      input: { actions: ["revalidate","sitemap","link_check"], source: "mcp_explicit_publish" }
    })
  }).catch(() => {});

  return { ok: true, published: true, article: JSON.parse(text)[0] };
}

async function siteStatus(env) {
  const site = await siteId(env);
  const [articlesRes, categoriesRes] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/articles?site_id=eq.${site}&select=id,status`, {
      headers: serviceHeaders(env, { Prefer: "count=exact" })
    }),
    fetch(`${env.SUPABASE_URL}/rest/v1/categories?site_id=eq.${site}&is_active=eq.true&select=id`, {
      headers: serviceHeaders(env, { Prefer: "count=exact" })
    })
  ]);
  if (!articlesRes.ok) throw new Error(await articlesRes.text());
  if (!categoriesRes.ok) throw new Error(await categoriesRes.text());
  const articles = await articlesRes.json();
  const counts = {};
  for (const a of articles) counts[a.status] = (counts[a.status] || 0) + 1;
  return {
    ok: true,
    site: "septicbeacon.com",
    protocol: PROTOCOL_VERSION,
    article_count: articles.length,
    article_statuses: counts,
    active_categories: (await categoriesRes.json()).length
  };
}

async function callTool(env, name, args) {
  switch (name) {
    case "site_status": return siteStatus(env);
    case "list_categories": return listCategories(env);
    case "list_articles": return listArticles(env, args);
    case "get_article": return getArticle(env, args);
    case "create_article": return createArticle(env, args);
    case "update_article": return updateArticle(env, args);
    case "import_media_from_url": return importMediaFromUrl(env, args);
    case "add_article_image": return addArticleImage(env, args);
    case "generate_article_image": return generateArticleImage(env, args);
    case "set_article_relations": return setArticleRelations(env, args);
    case "schedule_article": return scheduleArticle(env, args);
    case "publish_article": return publishArticle(env, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function discoverResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: "septicbeacon", title: "SepticBeacon CMS", version: "1.0.0" },
    capabilities: { tools: {} }
  };
}

export async function handleMcp(request, env) {
  const auth = await authorized(request, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="septicbeacon-mcp", resource_metadata="https://septicbeacon.com/.well-known/oauth-protected-resource"' } : {})
      }
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST, OPTIONS" } });
  }

  let body;
  try { body = await request.json(); }
  catch { return rpcError(null, -32700, "Parse error", undefined, 400); }

  const id = body?.id ?? null;
  const method = body?.method;
  if (body?.jsonrpc !== "2.0" || !method) return rpcError(id, -32600, "Invalid Request", undefined, 400);

  try {
    if (method === "initialize") {
      return jsonRpc(id, {
        protocolVersion: body?.params?.protocolVersion || LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "septicbeacon", title: "SepticBeacon CMS", version: "1.0.0" }
      });
    }
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "ping") return jsonRpc(id, {});
    if (method === "server/discover") return jsonRpc(id, discoverResult());
    if (method === "tools/list") return jsonRpc(id, { tools: TOOLS, ttlMs: 300000, cacheScope: "private" });
    if (method === "tools/call") {
      const name = body?.params?.name;
      const args = body?.params?.arguments || {};
      if (!name) return rpcError(id, -32602, "Tool name is required.");
      try {
        const value = await callTool(env, name, args);
        return jsonRpc(id, toolResult(value, value?.ok === false));
      } catch (e) {
        return jsonRpc(id, toolResult({ error: e?.message || String(e) }, true));
      }
    }
    return rpcError(id, -32601, "Method not found");
  } catch (e) {
    return rpcError(id, -32603, "Internal error", { message: e?.message || String(e) }, 500);
  }
}
