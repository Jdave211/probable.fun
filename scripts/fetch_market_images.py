#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "market-images"
MANIFEST = OUT_DIR / "manifest.json"
UA = "ProbableMarketImages/0.1 (local dev; Wikimedia Commons API; contact: local-dev@example.com)"
API = "https://commons.wikimedia.org/w/api.php"

SEARCH_QUERIES = [
    "FIFA World Cup football", "FIFA World Cup stadium", "FIFA World Cup fans", "FIFA World Cup trophy",
    "association football match", "association football players", "soccer ball pitch", "football stadium crowd",
    "international football supporters", "UEFA Champions League football", "national football team match",
    "football goal celebration", "football goalkeeper save", "football boots ball", "football referee match",
    "football tournament stadium", "World Cup opening ceremony", "World Cup final football",
]

CATEGORIES = [
    "Category:Association football matches", "Category:Association football players", "Category:Association football balls",
    "Category:Association football fans", "Category:FIFA World Cup", "Category:2014 FIFA World Cup",
    "Category:2018 FIFA World Cup", "Category:2022 FIFA World Cup", "Category:2022 FIFA World Cup matches",
    "Category:2018 FIFA World Cup matches", "Category:FIFA World Cup stadiums", "Category:Association football stadiums",
    "Category:National association football teams", "Category:Association football supporters", "Category:Association football referees",
]


def request_json(params: dict[str, str | int]) -> dict:
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=35) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 3:
                raise
            time.sleep(3 + attempt * 3)
    return {}


def download(url: str, dest: Path) -> tuple[bool, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as res:
        ctype = res.headers.get("Content-Type", "").split(";")[0].strip()
        data = res.read()
    if not ctype.startswith("image/") or len(data) < 2048:
        return False, ctype
    dest.write_bytes(data)
    return True, ctype


def clean_title(title: str) -> str:
    title = re.sub(r"^File:", "", title)
    title = re.sub(r"\.[A-Za-z0-9]+$", "", title)
    return re.sub(r"[_\s]+", " ", title).strip()


def ext_for(ctype: str, fallback_url: str) -> str:
    guessed = mimetypes.guess_extension(ctype) or ""
    if guessed in {".jpe", ".jpeg"}:
        return ".jpg"
    if guessed:
        return guessed
    suffix = Path(urllib.parse.urlparse(fallback_url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def load_existing() -> list[dict]:
    if not MANIFEST.exists():
        return []
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        return [item for item in data.get("images", []) if item.get("src")]
    except Exception:
        return []


def save(items: list[dict]) -> None:
    MANIFEST.write_text(json.dumps({"images": items}, indent=2), encoding="utf-8")


def add_page(page: dict, label: str, items: list[dict], seen_titles: set[str], seen_sources: set[str], limit: int) -> bool:
    info = (page.get("imageinfo") or [{}])[0]
    url = info.get("thumburl") or info.get("url")
    title = page.get("title", "")
    if not url or url in seen_sources or title in seen_titles or len(items) >= limit:
        return False
    mime = info.get("mime", "")
    if mime and not mime.startswith("image/"):
        return False
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    provisional = OUT_DIR / f"market-{len(items)+1:03d}-{digest}.tmp"
    try:
        ok, ctype = download(url, provisional)
    except Exception:
        provisional.unlink(missing_ok=True)
        return False
    if not ok:
        provisional.unlink(missing_ok=True)
        return False
    ext = ext_for(ctype, url)
    filename = f"market-{len(items)+1:03d}-{digest}{ext}"
    dest = OUT_DIR / filename
    provisional.replace(dest)
    meta = info.get("extmetadata") or {}
    artist = re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "")).strip()
    items.append({
        "src": f"/market-images/{filename}",
        "title": clean_title(title),
        "source": info.get("descriptionurl") or info.get("url"),
        "license": (meta.get("LicenseShortName") or {}).get("value") or "Wikimedia Commons",
        "artist": artist[:140],
        "query": label,
    })
    seen_sources.add(url)
    seen_titles.add(title)
    return True


def search_pages(query: str):
    data = request_json({
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": query, "gsrlimit": 50, "prop": "imageinfo",
        "iiprop": "url|mime|size|extmetadata", "iiurlwidth": 360, "origin": "*",
    })
    return data.get("query", {}).get("pages", {}).values()


def category_pages(category: str, max_pages: int = 4):
    cont: dict[str, str] = {}
    for _ in range(max_pages):
        params = {
            "action": "query", "format": "json", "generator": "categorymembers", "gcmtitle": category,
            "gcmtype": "file", "gcmlimit": 50, "prop": "imageinfo", "iiprop": "url|mime|size|extmetadata",
            "iiurlwidth": 360, "origin": "*", **cont,
        }
        data = request_json(params)
        yield from data.get("query", {}).get("pages", {}).values()
        cont = data.get("continue", {})
        if not cont:
            break


def main(limit: int = 220) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    items = load_existing()
    seen_sources = {item.get("source", "") for item in items}
    seen_titles = {item.get("title", "") for item in items}

    for query in SEARCH_QUERIES:
        if len(items) >= limit:
            break
        for page in search_pages(query):
            add_page(page, query, items, seen_titles, seen_sources, limit)
            if len(items) >= limit:
                break
        save(items)
        time.sleep(0.8)

    for category in CATEGORIES:
        if len(items) >= limit:
            break
        for page in category_pages(category):
            add_page(page, category, items, seen_titles, seen_sources, limit)
            if len(items) >= limit:
                break
            time.sleep(0.15)
        save(items)
        time.sleep(1.2)

    save(items)
    print(f"Manifest now has {len(items)} images at {MANIFEST}")


if __name__ == "__main__":
    main()
