# hn-distill

`hn-distill` is an Astro static site and a Bun/TypeScript data pipeline. The pipeline reads the Hacker News top stories feed, stores normalized stories and comments, optionally fetches linked article content, and uses OpenRouter to generate post summaries, discussion summaries, and tags. Astro reads the generated files and writes a static site.

The repository includes generated data under `data/`. A build does not fetch new data or call OpenRouter.

## Prerequisites

- Bun. The repository's GitHub action uses Bun `1.2.19`.
- Bash for the Make targets and `scripts/hourly-job.sh`.
- Network access to Hacker News. A full run also needs access to linked article URLs.
- `OPENROUTER_API_KEY` only when you want the summarization and tagging steps to call OpenRouter.
- Telegram credentials only when you want Telegram publication.
- Cloudflare R2 credentials only when you use `make pull-r2` or the R2 path in the hourly job.

## Install

```bash
make install
cp .env.example .env
```

The `.env` file is optional for building the data already in the repository. Edit it before running the pipeline or a publisher.

## Minimal run

To build the checked-in data and preview the static site:

```bash
make install
bun run build
bun run preview
```

To fetch the current Hacker News top stories and regenerate local outputs:

```bash
make install
bun run data:all
bun run build
bun run preview
```

`bun run data:all` runs fetch, summarize, and aggregate in that order. Without `OPENROUTER_API_KEY`, the summarize step exits without making LLM calls. Fetch and aggregate still run, but new post summaries and tags are not created.

For an interactive development server, use `make dev`. The build command copies `data/search.json` to `public/data/search.json` before running Astro's static build.

## Commands

There is no separate executable CLI. The entry points are package scripts and Make targets.

| Task | Command | Effect |
| --- | --- | --- |
| Install dependencies | `make install` | Runs Bun install using the lockfile when possible. |
| Fetch data | `bun run data:fetch` | Fetches top stories and comments into `data/`. |
| Summarize data | `bun run data:summarize` | Reads local raw data and writes summaries and tags when OpenRouter is configured. |
| Aggregate data | `bun run data:aggregate` | Updates `data/aggregated.json`, the search index, and date group files. |
| Run the full local pipeline | `make run` or `bun run data:all` | Runs fetch, summarize, and aggregate. |
| Build the site | `make build` or `bun run build` | Copies the search index and writes the static site to `dist/`. |
| Start development | `make dev` or `bun run dev` | Starts the Astro development server. |
| Preview a build | `make preview` or `bun run preview` | Serves the existing `dist/` directory. |
| Pull R2 data | `make pull-r2` | Downloads configured R2 keys into local `data/` paths. |
| Publish to Telegram | `make publish-telegram` | Sends selected unsent story messages when Telegram is configured. |
| Process one story | `bun run tsx scripts/process-one.mts <story-id>` | Processes one normalized story and may stream it to Telegram. |
| Remove low-score data | `make cleanup` | Deletes files for stories below the cleanup threshold. |
| Run tests | `make test` or `bun test` | Runs the Bun test suite. |
| Type-check | `make typecheck` | Runs TypeScript and Astro checks. |
| Lint | `make lint` | Runs ESLint. |

## Configuration

The parser and its defaults live in `config/env.ts`. `.env.example` contains explicit sample values for some variables, including model names. A value copied into `.env` overrides the parser default.

### Collection and HTTP

- `SUMMARY_LANG` accepts `ru` or `en` and defaults to `ru`.
- `TOP_N` defaults to `40` and limits the number of IDs read from Hacker News.
- `MAX_COMMENTS_PER_STORY` defaults to `40`.
- `MAX_DEPTH` defaults to `2`. Root comments have depth `1`.
- `CONCURRENCY` defaults to `8` and limits concurrent fetch work.
- `ARTICLE_SLICE_CHARS` defaults to `6000` characters sent to the post summarizer.
- `MAX_BODY_CHARS` defaults to `2000` characters per normalized comment.
- `HTTP_TIMEOUT_MS`, `HTTP_RETRIES`, and `HTTP_BACKOFF_MS` default to `15000`, `3`, and `600`.

### OpenRouter and summaries

- `OPENROUTER_API_KEY` is optional. The summarize workflow skips the whole step when it is empty.
- `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`, and `OPENROUTER_FALLBACK_MODEL_2` select the primary and fallback models. `OPENROUTER_MAX_TOKENS` defaults to `8000`.
- `POST_GUARD_ENABLE` defaults to `true`. The other `POST_GUARD_*` variables set the guard models, token limit, confidence threshold, and article input limit.
- `POST_SUMMARY_MIN_CHARS` defaults to `120`. The aggregate step drops post summaries that fail its blocking heuristics.
- `POST_SUMMARY_ONLY_IF_MISSING` defaults to `false`.
- `SUMMARIZE_MAX_STORIES_PER_RUN` defaults to `500`. `SUMMARIZE_COOLDOWN_MINUTES` defaults to `0`.
- `TAGS_MODEL`, `TAGS_MAX_TOKENS`, `TAGS_LANG`, and `TAGS_MAX_PER_STORY` control tag extraction. Tag language defaults to `en`, and the per-story limit defaults to `10`.
- `PDF_MAX_PAGES` and `PDF_MAX_BYTES` default to `12` and `10000000`.
- `YT_TRANSCRIPT_LANGS` is a comma-separated preference list. If it is empty, the code tries the summary language and then English.

For a story with a URL, the summarizer first checks its local Markdown cache. On a cache miss it fetches YouTube captions for recognized YouTube URLs. Other content is read as PDF, HTML converted to Markdown, or plain text based on the response. A story without a URL cannot receive a post summary.

### Site and logging

- `SITE` is optional and is passed to Astro. It is also used to form the site link in Telegram messages.
- `BASE` is optional. Astro uses `/` when it is absent.
- `LOG_LEVEL` accepts `silent`, `error`, `warn`, `info`, or `debug`, and defaults to `info`.

The UI uses root-relative links and the search page fetches `/data/search.json`. Test a non-root `BASE` value on the target host before relying on it.

### Telegram

Telegram publication requires `TELEGRAM_ENABLE=true`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. The parser defaults `TELEGRAM_ENABLE` to `true`, but the publisher exits without sending when either credential is missing.

- `TELEGRAM_MAX_ITEMS` defaults to `10`.
- `TELEGRAM_MESSAGE_THREAD_ID` selects a forum topic when set.
- `TELEGRAM_DISABLE_NOTIFICATIONS` defaults to `true`.
- `TELEGRAM_MESSAGE_DELAY_MS` defaults to `2000` milliseconds between messages.
- `TELEGRAM_MAX_RATE_LIMIT_RETRIES` defaults to `5`.
- `TELEGRAM_STREAM` defaults to `false`. When enabled, `processSingleStory` tries to send a story after its post summary is written.

`make publish-telegram` reads `data/aggregated.json`, sorts by story time, keeps items with a post summary, and skips IDs recorded in `data/telegram-sent.json`. It sends one message per selected story and records progress in `data/cache/`. The local hourly job skips this publisher in R2 mode because the Worker path handles Telegram tasks.

### Worker and Pages scheduling

The Worker reads the same logical data paths from R2 and stores processing state in D1.

- `WORKER_QUEUE_TASK_TIMEOUT_MS` defaults to `25000`.
- `WORKER_CRON_TIMEOUT_MS` defaults to `55000`.
- `WORKER_SUMMARIZE_MAX_PER_CRON` defaults to `3`.
- `WORKER_RETRY_COOLDOWN_SECONDS` defaults to `600`.
- `PAGES_DEPLOY_ENABLE` defaults to `true`.
- `PAGES_DEPLOY_HOOK_URL` is optional. Without it, no Pages hook request is made.
- `PAGES_DEPLOY_TARGET_PER_MONTH` defaults to `500`. The Worker spreads eligible hook calls across UTC hours and records the count in D1.

## Data flow and files

1. `scripts/fetch-hn.mts` reads `https://hacker-news.firebaseio.com/v0/topstories.json` and individual item endpoints. It writes normalized stories, fetched comments, `data/index.json`, and the comment seen cache.
2. `scripts/summarize.mts` reads the normalized files. With an OpenRouter key it fetches or reuses article content and writes `data/raw/articles/`, `data/summaries/*.post.json`, `data/summaries/*.comments.json`, and `data/summaries/*.tags.json`.
3. `scripts/aggregate.mts` reads `data/index.json` and the per-story files. It keeps stories with a score of at least `75`, merges them with the previous aggregate, and writes the aggregate and derived indexes.
4. The Astro pages read `data/aggregated.json`. The build copies `data/search.json` to `public/data/search.json` and writes static output to `dist/`.

The main generated files are:

- `data/index.json` with the latest fetch timestamp and story IDs.
- `data/raw/items/*.json` with normalized stories.
- `data/raw/comments/*.json` with normalized comments.
- `data/raw/articles/*.md` with cached linked content.
- `data/summaries/*.json` with post, comments, and tag results.
- `data/aggregated.json` with the site items.
- `data/search.json` with the client-side search rows.
- `data/by-date/daily.json` and `data/by-date/weekly.json` with ID groups.
- `data/telegram-sent.json` with the local Telegram sent-ID ledger.
- `data/cache/seen.json` and other files under `data/cache/` with runtime state. The cache directory is ignored by Git.

The static site has `/`, `/page/{n}/`, `/item/{id}/`, `/search/`, `/tags/`, and `/tag/{tag}/` routes. Tag pages are generated for tags used by at least two items.

## Deployment

The Astro configuration uses static output. Deploy the contents of `dist/` with the host of your choice after `make build`.

`vercel.json` sets the Vercel install command to `bun install`, the build command to `bun run build`, and the framework to Astro.

`wrangler.toml` describes a separate Cloudflare Worker named `hn-distill-pipeline`. It declares an hourly cron at minute `0`, an R2 binding named `DATA_BUCKET`, and a D1 binding named `DB`. The Worker exposes `/health` and runs the fetch, processing, aggregation, Telegram, and optional Pages hook steps from its scheduled handler. The checked-in Wrangler file does not declare a `TASKS` queue binding, so the Worker source uses inline processing when that binding is absent.

The repository does not define a Wrangler deploy script. The Cloudflare resources and Worker deployment need to be provisioned with the operator's Cloudflare tooling.

`.github/workflows/hourly-build.yml` is enabled only for `workflow_dispatch`. It installs dependencies, pulls R2 data, builds the site, and uploads a Pages artifact. It does not contain an hourly trigger or a Pages deployment step. `.github/workflows/ci.yml` runs the test suite on pushes, pull requests, and manual dispatches.

For a local scheduler and optional copy or deploy command, see [docs/self-hosted.md](docs/self-hosted.md).

## Operation notes

- `data/` is repository data. `make run`, `make pull-r2`, `make cleanup`, and summarization scripts can change it.
- `make pull-r2` can overwrite local files. It requires `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. Its default prefixes are `data/,summaries/`.
- `make local-test` removes `data`, `dist`, and `.astro` before running a five-story pipeline with reduced limits. Use it only when replacing the local generated data is intended.
- `make cleanup` removes raw, article, and summary files for stories below `SCORE_MIN_CLEANUP`, which is `50`, and removes those items from `data/aggregated.json`.
- A full local run makes requests to Hacker News and linked pages. With OpenRouter configured, it also consumes the configured model quota.
- `scripts/hourly-job.sh` uses a lock file to avoid overlapping runs. Its default lock path is `/tmp/hn-distill-hourly.lock`.
- `DEPLOY_COMMAND` is evaluated by the shell. Set it only to a command controlled by the operator.
