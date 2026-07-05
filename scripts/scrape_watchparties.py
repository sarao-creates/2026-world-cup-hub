#!/usr/bin/env python3
"""Scrape Eventbrite for World Cup watch parties across NYC's five boroughs.

Zero dependencies (stdlib only). Writes data/watchparties.json for the frontend.

Usage: python3 scripts/scrape_watchparties.py
"""
import json
import re
import time
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# Eventbrite location slugs to sweep. ny--new-york covers the whole city;
# borough-specific searches catch events the citywide page ranks too low.
SEARCHES = [
    ("ny--new-york", "world-cup-watch-party", 3),
    ("ny--new-york", "world-cup", 2),
    ("ny--brooklyn", "world-cup-watch-party", 1),
    ("ny--queens", "world-cup-watch-party", 1),
    ("ny--bronx", "world-cup-watch-party", 1),
    ("ny--staten-island", "world-cup-watch-party", 1),
]

LD_JSON_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S)


def borough_from_addr(addr):
    zip_code = str(addr.get("postalCode") or "")
    try:
        n = int(zip_code[:5])
    except ValueError:
        n = 0
    if 10001 <= n <= 10299:
        return "Manhattan"
    if 10300 <= n <= 10399:
        return "Staten Island"
    if 10400 <= n <= 10499:
        return "The Bronx"
    if 11200 <= n <= 11299:
        return "Brooklyn"
    if 11000 <= n <= 11199 or 11300 <= n <= 11499 or 11600 <= n <= 11699:
        return "Queens"
    loc = str(addr.get("addressLocality") or "").lower()
    if "brooklyn" in loc:
        return "Brooklyn"
    if "bronx" in loc:
        return "The Bronx"
    if "staten" in loc:
        return "Staten Island"
    if re.search(r"queens|astoria|flushing|long island city|jamaica|ridgewood"
                 r"|jackson heights|corona|woodside|sunnyside", loc):
        return "Queens"
    if re.search(r"new york|manhattan|harlem", loc):
        return "Manhattan"
    return None


def fetch(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Language": "en-US"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_events(html):
    events = []
    for raw in LD_JSON_RE.findall(html):
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(data, dict) or data.get("@type") != "ItemList":
            continue
        for li in data.get("itemListElement", []):
            ev = li.get("item") if isinstance(li, dict) else None
            if not ev or ev.get("@type") != "Event" or not ev.get("url"):
                continue
            loc = ev.get("location") or {}
            addr = loc.get("address") or {}
            events.append({
                "name": ev.get("name"),
                "url": ev["url"].split("?")[0],
                "startDate": (ev.get("startDate") or "")[:10],
                "endDate": (ev.get("endDate") or "")[:10],
                "description": (ev.get("description") or "")[:240],
                "image": ev.get("image"),
                "venueName": loc.get("name"),
                "address": ", ".join(
                    x for x in [addr.get("streetAddress"),
                                addr.get("addressLocality")] if x),
                "postalCode": addr.get("postalCode"),
                "borough": borough_from_addr(addr),
            })
    return events


def main():
    all_events = {}
    for loc_slug, query, pages in SEARCHES:
        for page in range(1, pages + 1):
            url = f"https://www.eventbrite.com/d/{loc_slug}/{query}/"
            if page > 1:
                url += f"?page={page}"
            print(f"Scraping {url} ... ", end="", flush=True)
            try:
                events = extract_events(fetch(url))
            except Exception as err:  # noqa: BLE001 — keep sweeping other pages
                print(f"failed ({err})")
                continue
            new = 0
            for ev in events:
                if not ev["borough"]:
                    continue  # not identifiably NYC
                if ev["url"] not in all_events:
                    all_events[ev["url"]] = ev
                    new += 1
            print(f"{len(events)} events, {new} new NYC")
            time.sleep(0.4)

    today = date.today().isoformat()
    events = sorted(
        (e for e in all_events.values()
         if e["startDate"] >= today or e["endDate"] >= today),
        key=lambda e: (e["startDate"], e["name"] or ""))

    by_borough = {}
    for e in events:
        by_borough[e["borough"]] = by_borough.get(e["borough"], 0) + 1

    output = {
        "scrapedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "eventbrite.com",
        "count": len(events),
        "byBorough": by_borough,
        "events": events,
    }
    out_path = ROOT / "data" / "watchparties.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"\nWrote data/watchparties.json — {len(events)} upcoming NYC watch parties")
    print(by_borough)


if __name__ == "__main__":
    main()
