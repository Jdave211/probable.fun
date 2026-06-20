#!/usr/bin/env python3
"""Enable Google OAuth for the Supabase project via the Management API.

Required env vars:
  SUPABASE_ACCESS_TOKEN  A Supabase personal access token.
  GOOGLE_CLIENT_ID       Google OAuth web client ID.
  GOOGLE_CLIENT_SECRET   Google OAuth web client secret.

Optional:
  SUPABASE_PROJECT_REF   Defaults to the project ref parsed from SUPABASE_URL.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv


def project_ref() -> str:
    explicit = os.environ.get("SUPABASE_PROJECT_REF", "").strip()
    if explicit:
        return explicit
    url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL") or ""
    host = urlparse(url).hostname or ""
    if host.endswith(".supabase.co"):
        return host.split(".")[0]
    raise SystemExit("Set SUPABASE_PROJECT_REF or SUPABASE_URL.")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name}.")
    return value


def main() -> None:
    load_dotenv(".env.local", override=False)
    load_dotenv(".env", override=False)

    token = required_env("SUPABASE_ACCESS_TOKEN")
    client_id = required_env("GOOGLE_CLIENT_ID")
    client_secret = required_env("GOOGLE_CLIENT_SECRET")
    ref = project_ref()

    payload = {
        "external_google_enabled": True,
        "external_google_client_id": client_id,
        "external_google_secret": client_secret,
    }
    response = httpx.patch(
        f"https://api.supabase.com/v1/projects/{ref}/config/auth",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if response.status_code >= 400:
        sys.stderr.write(f"Supabase auth config failed: {response.status_code} {response.text}\n")
        raise SystemExit(1)

    print(f"Google OAuth enabled for Supabase project {ref}.")
    print(f"Google callback URL: https://{ref}.supabase.co/auth/v1/callback")
    print("Also confirm Supabase Auth URL Configuration allows your app URLs, e.g. http://localhost:5173/** and your production URL.")


if __name__ == "__main__":
    main()
