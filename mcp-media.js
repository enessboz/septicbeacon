// RVFixWise MCP media helpers.
// Imports public HTTPS images into the existing R2 media library.

function serviceHeaders(env, extra = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json", ...extra };
  if (String(key || "").startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  return headers;
}

async function siteId(env) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/sites?domain=eq.rvfixwise.com&select=id&limit=1", { headers: serviceHeaders(env) });
  if (!r.ok) throw new Error(await r.text());
  const row = (await r.json())[0];
  if (!row?.id) throw new Error("RVFixWise site record not found.");
  return row.id;
}

async function articleById(env, site, id) {
  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/articles?site_id=eq." + site + "&id=eq." + encodeURIComponent(id) + "&select=*&limit=1",
    { headers: serviceHeaders(env) }
  );
  if (!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}

function safeBase(value = "rv-image") {
  return String(value || "rv-image")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "rv-image";
}

function extensionFor(contentType) {
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  return null;
}

function publicImageUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("image_url must be a valid URL."); }
  if (url.protocol !== "https:") throw new Error("image_url must use HTTPS.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    throw new Error("Local/private image URLs are not allowed.");
  }
  if (/^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Private-network image URLs are not allowed.");
  }
  return url;
}

function safeAlt(value) {
  return String(value || "").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

export const MEDIA_TOOLS = [
  {
    name: "generate_article_image",
    title: "Generate RVFixWise article image",
    description: "Generate an RV-related image with Cloudflare Workers AI, store it in RVFixWise R2 media, and attach it as a featured or inline article image.",
    inputSchema: {
      type: "object",
      required: ["article_id", "prompt", "alt_text", "placement"],
      properties: {
        article_id: { type: "string" },
        prompt: { type: "string", minLength: 10, maxLength: 2048 },
        alt_text: { type: "string", minLength: 1 },
        caption: { type: "string" },
        placement: { type: "string", enum: ["featured", "inline"] },
        after_heading: { type: "string" },
        steps: { type: "integer", minimum: 1, maximum: 8, default: 4 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "import_media_from_url",
    title: "Import image to RVFixWise media",
    description: "Download a public HTTPS WebP, PNG, or JPEG image into RVFixWise R2 media storage and optionally associate it with an article.",
    inputSchema: {
      type: "object",
      required: ["image_url", "alt_text"],
      properties: {
        image_url: { type: "string", minLength: 8 },
        alt_text: { type: "string", minLength: 1 },
        caption: { type: "string" },
        article_id: { type: "string" },
        prompt: { type: "string" }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "add_article_image",
    title: "Add image to RVFixWise article",
    description: "Import a public HTTPS image into RVFixWise R2 and use it as the featured image or insert it into article markdown.",
    inputSchema: {
      type: "object",
      required: ["article_id", "image_url", "alt_text", "placement"],
      properties: {
        article_id: { type: "string" },
        image_url: { type: "string", minLength: 8 },
        alt_text: { type: "string", minLength: 1 },
        caption: { type: "string" },
        prompt: { type: "string" },
        placement: { type: "string", enum: ["featured", "inline"] },
        after_heading: { type: "string" }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];

export async function importMediaFromUrl(env, args = {}) {
  if (!env.MEDIA_BUCKET) throw new Error("MEDIA_BUCKET R2 binding is not configured.");
  const site = await siteId(env);
  const remote = publicImageUrl(args.image_url);
  let article = null;
  if (args.article_id) {
    article = await articleById(env, site, args.article_id);
    if (!article) throw new Error("Article not found.");
  }

  const response = await fetch(remote.toString(), {
    redirect: "follow",
    headers: { "User-Agent": "RVFixWise-Media-Importer/1.0", "Accept": "image/webp,image/png,image/jpeg" }
  });
  if (!response.ok) throw new Error("Image download failed with HTTP " + response.status + ".");

  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = extensionFor(contentType);
  if (!ext) throw new Error("Unsupported image type: " + (contentType || "unknown") + ". Use WebP, PNG, or JPEG.");

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 8 * 1024 * 1024) throw new Error("Image is larger than 8 MB.");
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Downloaded image is empty.");
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Image is larger than 8 MB.");

  const now = new Date();
  const original = decodeURIComponent(remote.pathname.split("/").pop() || "rv-image");
  const base = safeBase(original.replace(/\.[^.]+$/, "") || args.alt_text);
  const key = site + "/" + now.getUTCFullYear() + "/" + String(now.getUTCMonth() + 1).padStart(2, "0") + "/" + base + "-" + Date.now().toString(36) + "." + ext;
  const alt = String(args.alt_text || "").trim().slice(0, 500);

  await env.MEDIA_BUCKET.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { site_id: site, alt_text: alt }
  });

  const publicUrl = "/media/" + key;
  const payload = {
    site_id: site,
    article_id: article?.id || null,
    storage_key: key,
    public_url: publicUrl,
    media_type: "image",
    alt_text: alt || null,
    caption: String(args.caption || "").trim().slice(0, 1200) || null,
    prompt: String(args.prompt || "").trim().slice(0, 4000) || null,
    original_name: original || null,
    mime_type: contentType,
    bytes: bytes.byteLength
  };

  const db = await fetch(env.SUPABASE_URL + "/rest/v1/media?select=*", {
    method: "POST",
    headers: serviceHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });
  const text = await db.text();
  if (!db.ok) {
    await env.MEDIA_BUCKET.delete(key).catch(() => {});
    throw new Error(text || "Media database record could not be created.");
  }
  return { ok: true, media: JSON.parse(text)[0] };
}

export async function addArticleImage(env, args = {}) {
  const site = args.site_id || await siteId(env);
  const article = await articleById(env, site, args.article_id);
  if (!article) throw new Error("Article not found.");

  const imported = await importMediaFromUrl(env, args);
  const media = imported.media;
  const alt = safeAlt(args.alt_text);

  if (args.placement === "featured") {
    const r = await fetch(
      env.SUPABASE_URL + "/rest/v1/articles?id=eq." + encodeURIComponent(article.id) + "&site_id=eq." + site + "&select=id,title,slug,featured_image_url,featured_image_alt",
      {
        method: "PATCH",
        headers: serviceHeaders(env, { Prefer: "return=representation" }),
        body: JSON.stringify({
          featured_image_url: media.public_url,
          featured_image_alt: alt,
          featured_image_prompt: String(args.prompt || article.featured_image_prompt || "").trim() || null,
          updated_at: new Date().toISOString()
        })
      }
    );
    const text = await r.text();
    if (!r.ok) throw new Error(text || "Featured image update failed.");
    return { ok: true, placement: "featured", media, article: JSON.parse(text)[0] };
  }

  if (args.placement !== "inline") throw new Error("placement must be featured or inline.");

  let imageMd = "![" + alt + "](" + media.public_url + ")";
  if (args.caption) imageMd += "\n*" + String(args.caption).trim() + "*";

  let markdown = String(article.content_markdown || "");
  const heading = String(args.after_heading || "").trim();
  let inserted = false;
  if (heading) {
    const target = heading.replace(/^#{1,6}\s+/, "").trim().toLowerCase();
    const lines = markdown.split("\n");
    const hit = lines.findIndex((line) =>
      /^#{1,6}\s+/.test(line) &&
      line.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === target
    );
    if (hit >= 0) {
      lines.splice(hit + 1, 0, "", imageMd, "");
      markdown = lines.join("\n");
      inserted = true;
    }
  }
  if (!inserted) markdown = markdown.trimEnd() + "\n\n" + imageMd + "\n";

  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/articles?id=eq." + encodeURIComponent(article.id) + "&site_id=eq." + site + "&select=id,title,slug,status,content_markdown",
    {
      method: "PATCH",
      headers: serviceHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify({ content_markdown: markdown, updated_at: new Date().toISOString() })
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Inline image insertion failed.");
  return { ok: true, placement: "inline", inserted_after_heading: inserted, media, article: JSON.parse(text)[0] };
}


async function saveGeneratedImage(env, article, args, jpegBytes, siteOverride=null) {
  const site = siteOverride || article.site_id || await siteId(env);
  const now = new Date();
  const base = safeBase(article.slug || args.alt_text || "rv-image");
  const key = site + "/" + now.getUTCFullYear() + "/" + String(now.getUTCMonth() + 1).padStart(2, "0") + "/" + base + "-ai-" + Date.now().toString(36) + ".jpg";
  const alt = String(args.alt_text || "").trim().slice(0, 500);

  await env.MEDIA_BUCKET.put(key, jpegBytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { site_id: site, alt_text: alt, generated_by: "workers-ai-flux-1-schnell" }
  });

  const publicUrl = "/media/" + key;
  const payload = {
    site_id: site,
    article_id: article.id,
    storage_key: key,
    public_url: publicUrl,
    media_type: "image",
    alt_text: alt || null,
    caption: String(args.caption || "").trim().slice(0, 1200) || null,
    prompt: String(args.prompt || "").trim().slice(0, 4000) || null,
    original_name: base + "-ai.jpg",
    mime_type: "image/jpeg",
    bytes: jpegBytes.byteLength
  };

  const db = await fetch(env.SUPABASE_URL + "/rest/v1/media?select=*", {
    method: "POST",
    headers: serviceHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(payload)
  });
  const text = await db.text();
  if (!db.ok) {
    await env.MEDIA_BUCKET.delete(key).catch(() => {});
    throw new Error(text || "Generated media database record could not be created.");
  }
  return JSON.parse(text)[0];
}

async function attachStoredMedia(env, article, media, args, siteOverride=null) {
  const site = siteOverride || article.site_id || await siteId(env);
  const alt = safeAlt(args.alt_text);

  if (args.placement === "featured") {
    const r = await fetch(
      env.SUPABASE_URL + "/rest/v1/articles?id=eq." + encodeURIComponent(article.id) + "&site_id=eq." + site + "&select=id,title,slug,status,featured_image_url,featured_image_alt",
      {
        method: "PATCH",
        headers: serviceHeaders(env, { Prefer: "return=representation" }),
        body: JSON.stringify({
          featured_image_url: media.public_url,
          featured_image_alt: alt,
          featured_image_prompt: String(args.prompt || "").trim() || null,
          updated_at: new Date().toISOString()
        })
      }
    );
    const text = await r.text();
    if (!r.ok) throw new Error(text || "Featured image update failed.");
    return { article: JSON.parse(text)[0], inserted_after_heading: false };
  }

  if (args.placement !== "inline") throw new Error("placement must be featured or inline.");

  let imageMd = "![" + alt + "](" + media.public_url + ")";
  if (args.caption) imageMd += "\n*" + String(args.caption).trim() + "*";

  let markdown = String(article.content_markdown || "");
  const heading = String(args.after_heading || "").trim();
  let inserted = false;
  if (heading) {
    const target = heading.replace(/^#{1,6}\s+/, "").trim().toLowerCase();
    const lines = markdown.split("\n");
    const hit = lines.findIndex((line) =>
      /^#{1,6}\s+/.test(line) &&
      line.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === target
    );
    if (hit >= 0) {
      lines.splice(hit + 1, 0, "", imageMd, "");
      markdown = lines.join("\n");
      inserted = true;
    }
  }
  if (!inserted) markdown = markdown.trimEnd() + "\n\n" + imageMd + "\n";

  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/articles?id=eq." + encodeURIComponent(article.id) + "&site_id=eq." + site + "&select=id,title,slug,status,content_markdown",
    {
      method: "PATCH",
      headers: serviceHeaders(env, { Prefer: "return=representation" }),
      body: JSON.stringify({ content_markdown: markdown, updated_at: new Date().toISOString() })
    }
  );
  const text = await r.text();
  if (!r.ok) throw new Error(text || "Inline image insertion failed.");
  return { article: JSON.parse(text)[0], inserted_after_heading: inserted };
}

export async function generateArticleImage(env, args = {}) {
  if (!env.AI) throw new Error("Cloudflare Workers AI binding is not configured.");
  if (!env.MEDIA_BUCKET) throw new Error("MEDIA_BUCKET R2 binding is not configured.");

  const site = args.site_id || await siteId(env);
  const article = await articleById(env, site, args.article_id);
  if (!article) throw new Error("Article not found.");

  const prompt = String(args.prompt || "").trim();
  if (prompt.length < 10) throw new Error("A descriptive image prompt is required.");

  const rvPrompt = [
    "Create a realistic editorial photograph for an RV repair and maintenance website.",
    "Topic: " + prompt,
    "The image should look practical, trustworthy, technically plausible, and useful to an RV owner.",
    "Natural lighting, clean composition, realistic RV components, no logos, no watermarks, no text overlay.",
    "Avoid unsafe repair behavior, exaggerated damage, fantasy elements, or clutter."
  ].join(" ");

  const generated = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
    prompt: rvPrompt.slice(0, 2048),
    steps: Math.min(8, Math.max(1, Number(args.steps || 4)))
  });

  if (!generated?.image) throw new Error("Workers AI did not return an image.");
  const binary = atob(generated.image);
  const jpeg = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (!jpeg.byteLength) throw new Error("Workers AI returned an empty image.");

  const media = await saveGeneratedImage(env, article, args, jpeg, site);
  const attached = await attachStoredMedia(env, article, media, args, site);

  return {
    ok: true,
    model: "@cf/black-forest-labs/flux-1-schnell",
    placement: args.placement,
    media,
    article: attached.article,
    inserted_after_heading: attached.inserted_after_heading
  };
}
