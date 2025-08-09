# Hacker News Digest (Astro)

- What: Static site that fetches top Hacker News stories, distills article text and comments, and publishes daily/weekly digests.
- Requires: `bun`.
- Setup: `cp .env.example .env` and set `OPENROUTER_API_KEY` (optional for summaries) and `JINA_API_KEY` (optional reader).
- Generate data: `bun install` then `bun run data:all` (or `make run`).
- Develop: `bunx astro dev` (or `make dev`).
- Build/preview: `bunx astro build && bunx astro preview` (or `make build`/`make preview`).

Data outputs land in `data/`; the site reads `data/aggregated.json`.
