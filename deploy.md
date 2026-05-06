# Deploy: ai-native-jobs

Production target: `https://ai-native-jobs.tommyato.com` on the tommyato droplet (`67.205.167.181`). The `.com` is deferred — flip via `PUBLIC_SITE_URL` env when registered.

## Schema migration contract

`bun run migrate` aborts startup if it would silently drop any column the code doesn't know about. Specifically, any table-rebuild migration (currently: the companies-table WaaS constraint expansion) runs `PRAGMA table_info(<table>)` before touching anything and throws `Migration would drop unknown columns: [<list>]; aborting. Investigate before retrying.` if it finds a column outside the canonical schema. This is intentional: ops must either `ALTER TABLE <table> DROP COLUMN <col>` or add the column to the canonical schema in code before the migration will proceed. Never add columns to production tables out-of-band without also updating the canonical column set in `src/db/migrate.ts`.

## Topology

| Layer | Where |
| --- | --- |
| **App code** | `/opt/ai-native-jobs/` (Astro + Bun, runs `dist/server/entry.mjs`) |
| **Data** | `/mnt/data/ai-native-jobs/ai-native-jobs.db` (SQLite, root:root 0644) |
| **Env** | `/etc/ai-native-jobs/env` (mode 0600 root:root — has `STRIPE_LIVE_*` + `STRIPE_WEBHOOK_SECRET`) |
| **Service** | `ai-native-jobs.service` (systemd, port 8790, restart=always) |
| **Logs** | `/var/log/ai-native-jobs.log`, `/var/log/ai-native-jobs-scrape.log`, `/var/log/caddy/ai-native-jobs.log` |
| **TLS / proxy** | Caddy block in `/etc/caddy/Caddyfile` → `localhost:8790` |
| **DNS** | Wildcard `*.tommyato.com` A record → `67.205.167.181` (Porkbun, set up at droplet provision time) |
| **Scrape** | `ai-native-jobs-scrape.timer` (oneshot, daily 02:00 UTC + RandomizedDelaySec=600). Runs `scrape:ats:all` → `astro build` → `systemctl restart ai-native-jobs`. |
| **Webhook** | Stripe live `we_1TTpqJKtyOletzSTr5nXkDv0` (`checkout.session.completed`) → `https://ai-native-jobs.tommyato.com/api/stripe/webhook` |
| **Analytics** | Plausible site id 2 at `https://analytics.tommyato.com/ai-native-jobs.tommyato.com` |

## Updating production from a clean checkout

Source-only deploy from brain (rsync isn't installed in container — use `tar | ssh`):

    cd /Users/tommyato/Documents/projects/superhq/projects/ai-native-jobs
    git pull
    tar --exclude=./node_modules --exclude=./dist --exclude=./data --exclude=./.git --exclude=./.astro --exclude='./.env*' -cf - . \
      | ssh -i /Users/tommyato/.config/tommyato/ssh/id_ed25519 root@67.205.167.181 \
        "cd /opt/ai-native-jobs && tar -xf -"

**Anchor every `--exclude` with `./`.** Bare `--exclude=data` matches *any* directory named `data` at any depth — including `src/data/` (curated companies live there). Anchoring at `./` exempts only the top-level local SQLite directory. Lost ~10 minutes 2026-05-06 to this — the deploy looked successful but skipped `src/data/curated-companies.ts`.
    ssh -i /Users/tommyato/.config/tommyato/ssh/id_ed25519 root@67.205.167.181 '
      cd /opt/ai-native-jobs && \
      bun install && \
      AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run migrate && \
      PUBLIC_SITE_URL=https://ai-native-jobs.tommyato.com \
        AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db \
        bun --bun ./node_modules/.bin/astro build && \
      systemctl restart ai-native-jobs.service
    '

`bun --bun astro build` is required because the droplet runs node 20 and our config-time DB read uses `node:sqlite` (added in node 22). The `--bun` flag forces bun runtime for the astro CLI.

## Careers probe rollout

`companies` now carries ATS enrichment state:

- `ats_provider`
- `careers_probe_at`
- `careers_probe_result`

After `bun run migrate`, seed YC companies, then run the enrichment before the ATS scrape if you need to rebuild the pool from scratch:

    AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run scrape:yc
    AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run probe:careers
    AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run scrape:ats:all

## Curated non-YC companies (issue #28)

Hand-maintained AI-native companies that aren't in YC live in `src/data/curated-companies.ts` and seed via `bun run seed:curated` (idempotent upsert by slug, never deletes). The scrape timer (`ai-native-jobs-scrape.service`) runs `seed:curated` as `ExecStartPre` before `scrape:ats:all`, so editing the .ts file + redeploying is sufficient — the next 02:00 UTC fire picks up the change. To populate immediately:

    AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run seed:curated
    AINATIVE_DB_PATH=/mnt/data/ai-native-jobs/ai-native-jobs.db bun run scrape:ats <slug>
    PUBLIC_SITE_URL=https://ai-native-jobs.tommyato.com AINATIVE_DB_PATH=... bun --bun ./node_modules/.bin/astro build
    systemctl restart ai-native-jobs.service

`seedCurated` writes `id='curated-<slug>'` so curated rows never collide with YC rows (which use UUIDs). Slugs MUST be unique across YC + curated — the upsert ON CONFLICT(slug) clause silently merges if they collide. New entries: confirm `careers_url` returns HTTP 200 and the slug is not already in the YC import.

## Adding a code-side deploy key (deferred)

Right now deploys are pushed from brain via tar-over-ssh. To switch to droplet-pulls-from-GitHub:

1. `ssh-keygen -t ed25519 -f /opt/ai-native-jobs-deploy_key -N '' -C 'deploy@droplet'`
2. Add the `.pub` to https://github.com/two8one7/ai-native-jobs/settings/keys (read-only).
3. Replace the rsync step above with `git pull` from `/opt/ai-native-jobs/` (clone with `GIT_SSH_COMMAND='ssh -i /opt/ai-native-jobs-deploy_key' git clone git@github.com:two8one7/ai-native-jobs.git`).

## When the .com gets registered

1. Porkbun: A record `ai-native-jobs.com` → `67.205.167.181`, `www` → CNAME `ai-native-jobs.com`.
2. Caddy: change `ai-native-jobs.tommyato.com` block site name to `ai-native-jobs.com, www.ai-native-jobs.com`. Pre-create new log file (`install -o caddy -g caddy -m 600 /dev/null /var/log/caddy/ai-native-jobs.log` already exists; reuse). `systemctl reload caddy`.
3. Env: `PUBLIC_SITE_URL=https://ai-native-jobs.com` in `/etc/ai-native-jobs/env`.
4. Source: update `public/robots.txt` Sitemap line + `public/llms.txt` URLs to the .com (rebuild + restart).
5. Stripe: create a second live webhook on the .com URL (don't delete the subdomain one until you've confirmed the new one fires). Update `STRIPE_WEBHOOK_SECRET` in env, restart.
6. Plausible: add a second site for `ai-native-jobs.com` (the existing subdomain site keeps its history; the new site starts at 0). Update `data-domain` in `Base.astro`.

## Caddy reload gotcha

Always pre-create the log file with `caddy:caddy` ownership BEFORE adding a Caddyfile block, otherwise the reload silently times out and the unit gets stuck `reloading`:

    install -o caddy -g caddy -m 600 /dev/null /var/log/caddy/ai-native-jobs.log

(Already done for this service.)

## Manually triggering a scrape

    ssh -i /Users/tommyato/.config/tommyato/ssh/id_ed25519 root@67.205.167.181 systemctl start ai-native-jobs-scrape.service

Watch logs:

    ssh -i /Users/tommyato/.config/tommyato/ssh/id_ed25519 root@67.205.167.181 tail -f /var/log/ai-native-jobs-scrape.log

## Smoke test after every deploy

    curl -sI https://ai-native-jobs.tommyato.com/ | head -3
    curl -s -o /dev/null -w '%{http_code}\n' https://ai-native-jobs.tommyato.com/post
    curl -s -o /dev/null -w '%{http_code}\n' https://ai-native-jobs.tommyato.com/jobs.json
    curl -X POST https://ai-native-jobs.tommyato.com/api/stripe/webhook \
      -H 'stripe-signature: bogus' -d '{}' -o /dev/null -w 'expect 400, got %{http_code}\n'
