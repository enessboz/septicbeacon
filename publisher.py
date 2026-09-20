#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SITE = os.getenv("WP_SITE_URL", "https://septicbeacon.com").rstrip("/")
USERNAME = os.getenv("WP_USERNAME", "").strip()
APP_PASSWORD = os.getenv("WP_APP_PASSWORD", "").replace(" ", "").strip()
IMAGE_TOKEN_RE = re.compile(r"\{\{image:([a-zA-Z0-9_-]+)\}\}")

def die(message, code=1):
    print(f"ERROR: {message}")
    raise SystemExit(code)

def auth_header():
    if not USERNAME or not APP_PASSWORD:
        die("WP_USERNAME and WP_APP_PASSWORD must be configured as GitHub Actions secrets.")
    token = base64.b64encode(f"{USERNAME}:{APP_PASSWORD}".encode()).decode()
    return f"Basic {token}"

def api_request(method, path, payload=None):
    url = f"{DEFAULT_SITE}/wp-json/wp/v2/{path.lstrip('/')}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": auth_header(),
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "SepticBeacon-GitHub-Publisher/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        die(f"WordPress API returned HTTP {exc.code}: {body[:1500]}")
    except urllib.error.URLError as exc:
        die(f"Could not reach WordPress API: {exc}")

def verify_auth():
    me = api_request("GET", "users/me?context=edit")
    print(f"Authenticated to {DEFAULT_SITE} as WordPress user #{me.get('id')} ({me.get('name', 'unknown')}).")

def load_job(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            job = json.load(f)
    except Exception as exc:
        die(f"Could not read {path}: {exc}")
    if not isinstance(job, dict):
        die(f"{path}: top-level JSON must be an object.")
    return job

def read_media_bytes(item):
    if item.get("file"):
        path = Path(item["file"])
        if not path.exists():
            die(f"Media file not found: {path}")
        mime_type, _ = mimetypes.guess_type(str(path))
        return path.read_bytes(), item.get("filename") or path.name, mime_type or "application/octet-stream"

    if item.get("file_b64"):
        path = Path(item["file_b64"])
        if not path.exists():
            die(f"Base64 media file not found: {path}")
        try:
            binary = base64.b64decode(path.read_text(encoding="utf-8").strip(), validate=True)
        except Exception as exc:
            die(f"Could not decode {path}: {exc}")
        filename = item.get("filename")
        if not filename:
            die(f"Media item using file_b64 must include 'filename': {path}")
        mime_type = item.get("mime_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return binary, filename, mime_type

    die("Each media item must include either 'file' or 'file_b64'.")

def upload_media_item(item):
    binary, filename, mime_type = read_media_bytes(item)
    url = f"{DEFAULT_SITE}/wp-json/wp/v2/media"
    req = urllib.request.Request(
        url,
        data=binary,
        method="POST",
        headers={
            "Authorization": auth_header(),
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": mime_type,
            "User-Agent": "SepticBeacon-GitHub-Publisher/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            media = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        die(f"Media upload failed for {filename} with HTTP {exc.code}: {body[:1500]}")
    except urllib.error.URLError as exc:
        die(f"Could not upload media {filename}: {exc}")

    media_id = media["id"]
    update_payload = {}
    for key in ("title", "alt_text", "caption", "description"):
        if item.get(key):
            update_payload[key] = item[key]
    if update_payload:
        api_request("POST", f"media/{media_id}", update_payload)
        media = api_request("GET", f"media/{media_id}?context=edit")

    return {
        "id": media_id,
        "source_url": media.get("source_url"),
        "alt_text": media.get("alt_text", item.get("alt_text", "")),
    }

def build_image_html(media_info, item):
    classes = item.get("class", "wp-block-image size-large")
    alt = media_info.get("alt_text") or ""
    src = media_info.get("source_url") or ""
    caption = item.get("caption", "")
    if caption:
        return f'<figure class="{classes}"><img src="{src}" alt="{alt}" loading="lazy" /><figcaption>{caption}</figcaption></figure>'
    return f'<figure class="{classes}"><img src="{src}" alt="{alt}" loading="lazy" /></figure>'

def process_media(job):
    uploaded = {}
    featured_media_id = None
    featured_key = job.get("featured_media_key")
    for item in job.get("media", []):
        key = item.get("key")
        if not key:
            die("Each media item must include a unique 'key'.")
        info = upload_media_item(item)
        uploaded[key] = {"meta": info, "html": build_image_html(info, item)}
        print(f"UPLOADED media {key} -> #{info['id']}")
        if featured_key == key:
            featured_media_id = info["id"]
    return uploaded, featured_media_id

def replace_image_tokens(content, uploaded_media):
    def repl(match):
        key = match.group(1)
        if key not in uploaded_media:
            die(f"Content references image key '{key}' but it was not uploaded.")
        return uploaded_media[key]["html"]
    return IMAGE_TOKEN_RE.sub(repl, content)

def clean_post_payload(job):
    allowed = {
        "title", "content", "excerpt", "status", "slug",
        "categories", "tags", "featured_media", "date", "date_gmt",
        "author", "sticky", "comment_status", "ping_status", "format", "meta",
    }
    payload = {k: v for k, v in job.items() if k in allowed}
    if not payload:
        die("Job has no WordPress post fields to send.")
    return payload

def process(path):
    job = load_job(path)
    if job.get("enabled", True) is False:
        print(f"SKIP {path}: enabled=false")
        return

    uploaded_media, featured_media_id = process_media(job)
    if uploaded_media and "content" in job:
        job["content"] = replace_image_tokens(job["content"], uploaded_media)
    if featured_media_id:
        job["featured_media"] = featured_media_id

    action = str(job.get("action", "update")).lower()
    payload = clean_post_payload(job)

    if action == "update":
        post_id = job.get("id")
        if not post_id:
            die(f"{path}: update action requires numeric 'id'.")
        before = api_request("GET", f"posts/{int(post_id)}?context=edit")
        expected_slug = job.get("expect_slug")
        if expected_slug and before.get("slug") != expected_slug:
            die(f"{path}: safety check failed. Post {post_id} slug is '{before.get('slug')}', expected '{expected_slug}'.")
        result = api_request("POST", f"posts/{int(post_id)}", payload)
        print(f"UPDATED post #{result.get('id')}: {result.get('link')}")
    elif action == "create":
        result = api_request("POST", "posts", payload)
        print(f"CREATED post #{result.get('id')}: {result.get('link')}")
    else:
        die(f"{path}: unsupported action '{action}'. Use update or create.")

def main():
    parser = argparse.ArgumentParser(description="Publish SepticBeacon WordPress jobs from JSON.")
    parser.add_argument("files", nargs="*", help="JSON job files. Defaults to posts/*.json")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    verify_auth()
    if args.verify_only:
        print("Authentication test passed.")
        return

    files = [Path(p) for p in args.files] if args.files else sorted(Path("posts").glob("*.json"))
    if not files:
        print("No post job files found. Nothing to publish.")
        return
    for path in files:
        print(f"Processing {path}...")
        process(path)

if __name__ == "__main__":
    main()
