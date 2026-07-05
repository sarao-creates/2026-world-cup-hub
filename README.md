# ⚽ World Cup 2026 Hub

Live bracket + group stage for the 2026 FIFA World Cup, with match details
(scores, scorers, highlight clips, fan reactions) and NYC watch parties for
upcoming games.

**Pure static site** — no build step, no server. Live scores come straight from
ESPN's public API in the browser (CORS-enabled) and auto-refresh every 60
seconds. Watch parties are scraped from Eventbrite into `data/watchparties.json`.

## Run locally

```bash
npm run scrape   # pull latest NYC watch parties from Eventbrite (python3, stdlib only)
npm run serve    # serve at http://localhost:8642 (any static server works)
```

## Features

- **Bracket tab** — full knockout bracket (Round of 32 → Final, split left/right
  around the final), self-updating every 60s. Live matches pulse green; the
  champion banner appears after the final.
- **Group Stage tab** — all 12 group tables with qualification markers plus each
  group's fixtures/results.
- **Click a finished/live match** — score, goal scorers (with assists, pens,
  own goals), inline highlight video clips, and links to top posts on X.
- **Click an upcoming match** — watch parties in NYC on match day, grouped by
  borough (all five), with venue, address, and ticket links. Parties mentioning
  either team are badged "Featured for this match".

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. Settings → Pages → Deploy from branch → `main` / root.
3. Done — the site fetches live data client-side, so scores/bracket/highlights
   stay current with zero rebuilds.
4. The included workflow (`.github/workflows/scrape.yml`) re-scrapes watch
   parties 3× daily and commits the fresh JSON automatically.

## Data sources

- Scores/bracket/standings/scorers/videos: `site.api.espn.com` public JSON API
- Watch parties: Eventbrite search pages (JSON-LD), NYC boroughs by zip code
- Fan reactions: deep links into X search (embedding tweets requires the paid X API)
