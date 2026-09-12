# Self-hosted hourly job

`scripts/hourly-job.sh` runs one pipeline cycle. It does not schedule itself. Use cron, a systemd timer, or macOS `launchd` to invoke it once per hour.

The script loads `.env`, prevents overlapping runs with a lock file, chooses local or R2 data, optionally publishes to Telegram, builds the static site, and optionally commits or deploys the result.

## Prerequisites

- Bun and Bash.
- Dependencies installed with `make install`.
- Network access to Hacker News. A local run with summaries also needs access to linked article URLs and OpenRouter.
- `OPENROUTER_API_KEY` for post, comments, and tag generation.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for local Telegram publication.
- All four R2 variables for the R2 path: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`.

## One-time setup

```bash
make install
cp .env.example .env
```

Set the variables required by the path you will run. The `.env` file is ignored by Git.

For deployment, set one or both of these variables:

```bash
DEPLOY_DIR=/var/www/hn-distill
DEPLOY_COMMAND='rsync -az --delete dist/ user@host:/var/www/hn-distill/'
```

`DEPLOY_COMMAND` is evaluated by the shell. Use only a command controlled by the operator.

## Run once

```bash
./scripts/hourly-job.sh
```

The script returns after the selected pipeline, build, and deployment commands finish. Set `LOG_DIR` to have the script append output to `LOG_FILE`, which defaults to `LOG_DIR/hourly.log`.

## Scheduling

### Linux cron

Edit the crontab:

```bash
crontab -e
```

Add a line with paths adjusted for the host:

```cron
PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
0 * * * * LOG_DIR=/path/to/hn-distill/logs /path/to/hn-distill/scripts/hourly-job.sh
```

The script creates `LOG_DIR` before it opens its log file.

### Linux systemd timer

Create `/etc/systemd/system/hn-distill.service`:

```ini
[Unit]
Description=HN Distill hourly job
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/hn-distill
Environment=LOG_DIR=/var/log/hn-distill
Environment=DEPLOY_DIR=/var/www/hn-distill
ExecStart=/path/to/hn-distill/scripts/hourly-job.sh
```

Create `/etc/systemd/system/hn-distill.timer`:

```ini
[Unit]
Description=Run HN Distill hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hn-distill.timer
```

### macOS launchd

Create `~/Library/LaunchAgents/com.hn-distill.hourly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.hn-distill.hourly</string>
    <key>ProgramArguments</key>
    <array>
      <string>/path/to/hn-distill/scripts/hourly-job.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/hn-distill</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>LOG_DIR</key>
      <string>/path/to/hn-distill/logs</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/path/to/hn-distill/logs/hourly.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/hn-distill/logs/hourly.log</string>
  </dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.hn-distill.hourly.plist
```

## Execution order

1. If `GIT_PULL_BEFORE=true`, run `git pull --rebase` for `GIT_REMOTE` and `GIT_BRANCH`.
2. If `USE_R2=true`, run `make pull-r2`. The script also selects this path when either `R2_ACCOUNT_ID` or `R2_ACCESS_KEY_ID` is non-empty. `make pull-r2` then requires all four R2 variables. Otherwise, run `make run`.
3. In local mode, run `make publish-telegram` when `TELEGRAM_ENABLE` is `true`. In R2 mode, skip local Telegram publication.
4. If `GIT_ENABLE=true` and files under `data/` changed, add `data/`, create a commit, pull with rebase, and push to `GIT_REMOTE` and `GIT_BRANCH`.
5. Run `make build`, which writes the static site to `dist/`.
6. If `DEPLOY_DIR` is set, copy `dist/` there. The script uses `rsync -a --delete` when `rsync` is available and otherwise uses `cp -R`.
7. If `DEPLOY_COMMAND` is set, evaluate it after the local copy.

## Variables used by the runner

| Variable | Default | Effect |
| --- | --- | --- |
| `USE_R2` | `false` | Selects the R2 download path when `true`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | unset | Credentials and bucket for `make pull-r2`. |
| `R2_PREFIXES` | `data/,summaries/` | Comma-separated R2 prefixes to list. R2 keys under `summaries/` are written to `data/summaries/`. |
| `GIT_ENABLE` | `false` | Allows the runner to commit changed data and push it. |
| `GIT_REMOTE` | `origin` | Git remote used by pull and push. |
| `GIT_BRANCH` | `main` | Branch used by pull and push. |
| `GIT_COMMIT_MESSAGE` | `hourly data` | Commit message for a data commit. |
| `GIT_USER_NAME` | `bot` | Git author name for a data commit. |
| `GIT_USER_EMAIL` | `bot@example.com` | Git author email for a data commit. |
| `GIT_PULL_BEFORE` | `false` | Pulls with rebase before the pipeline. |
| `DEPLOY_DIR` | unset | Destination directory for the built `dist/` files. |
| `DEPLOY_COMMAND` | unset | Shell command evaluated after `DEPLOY_DIR`. |
| `LOG_DIR` | unset | Redirects both streams to a log file in this directory. |
| `LOG_FILE` | `$LOG_DIR/hourly.log` | Log file used when `LOG_DIR` is set. |
| `LOCK_FILE` | `/tmp/hn-distill-hourly.lock` | Lock file used to prevent overlapping runs. |
| `TELEGRAM_STREAM` | `false` | Passed to the summarizer; when `true`, it tries to publish each story after its post summary. |

The other pipeline variables are documented in the [main configuration section](../README.md#configuration). The full parser is `config/env.ts`.

## Operation notes

- A stale lock is removed when its PID is no longer running. A live lock makes the script exit successfully without starting another run.
- `make pull-r2` can overwrite local data. The pull script downloads the keys selected by `R2_PREFIXES` and writes them under `data/`.
- `make run` changes generated files under `data/` and can make external requests. With OpenRouter configured, it also uses model quota.
- `make local-test` removes `data`, `dist`, and `.astro` before generating a small data set. Do not use it on a checkout whose generated data must be kept.
- `make cleanup` deletes raw, article, and summary files for stories below the score threshold and updates `data/aggregated.json`.
- In R2 mode the runner builds from the downloaded data and skips its local Telegram publisher. The Cloudflare Worker has its own Telegram path.
