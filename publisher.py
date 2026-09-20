#!/usr/bin/env python3
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SITE = os.getenv("WP_SITE_URL", "https://septicbeacon.com").rstrip("/")
USERNAME = os.getenv("WP_USERNAME", "").strip()
APP_PASSWORD = os.getenv("WP_APP_PASSWORD", "").replace(" ", "").strip()

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
            "User-Agent": "SepticBeacon-GitHub-Publisher/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        die(f"WordPress API returned HTTP {exc.code}: {body[:1200]}")
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

def clean_post_payload(job):
    allowed = {
        "title", "content", "excerpt", "status", "slug",
        "categories", "tags", "featured_media", "date", "date_gmt",
        "author", "sticky", "comment_status", "ping_status", "format",
        "meta",
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

    action = str(job.get("action", "update")).lower()
    payload = clean_post_payload(job)

    if action == "update":
        post_id = job.get("id")
        if not post_id:
            die(f"{path}: update action requires numeric 'id'.")
        before = api_request("GET", f"posts/{int(post_id)}?context=edit")
        expected_slug = job.get("expect_slug")
        if expected_slug and before.get("slug") != expected_slug:
            die(
                f"{path}: safety check failed. Post {post_id} slug is "
                f"'{before.get('slug')}', expected '{expected_slug}'."
            )
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
    parser.add_argument("--verify-only", action="store_true", help="Only test WordPress authentication.")
    args = parser.parse_args()

    verify_auth()
    if args.verify_only:
        print("Authentication test passed.")
        return

    files = [Path(p) for p in args.files]
    if not files:
        files = sorted(Path("posts").glob("*.json"))

    if not files:
        print("No post job files found. Nothing to publish.")
        return

    for path in files:
        print(f"Processing {path}...")
        process(path)

if __name__ == "__main__":
    main()
