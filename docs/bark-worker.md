# bark-worker

`servers/bark-worker` is a `git subtree` import of the upstream
[cwxiaos/bark-worker](https://github.com/cwxiaos/bark-worker) project
(squashed, same pattern as `hevy-mcp` and `vinted-mcp`). It's a
[Bark-Server](https://github.com/Finb/bark-server) reimplementation that
runs directly as a Cloudflare Worker (backed by D1), used to push
notifications to the [Bark](https://github.com/Finb/Bark) iOS app. Unlike
`hevy-mcp`/`vinted-mcp` it needs no separate `worker/` wrapper — the
upstream project is already Worker-native and exposes an MCP endpoint
(`/mcp`, with a `notify` tool) alongside its REST push API.

The only deviation from a pristine subtree: `servers/bark-worker/.github/`
(its own `workflow_dispatch`-driven deploy workflow, which creates the D1
database and takes Cloudflare credentials as manual inputs) was removed,
same treatment as `hevy-mcp`'s upstream `.github/` — this repo deploys it
through its own workflow instead, reusing repo-level secrets.

CI (`.github/workflows/deploy-bark-worker.yml`) tests and deploys the
Worker to `workers.dev` on every push to `main` that touches
`servers/bark-worker/**`, or on demand via the Actions tab
(`workflow_dispatch`).

## One-time Cloudflare + GitHub setup

Reuses the same `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` repo
secrets as the other servers (the token additionally needs D1 permission
for this one) — nothing new to configure there if those are already set
up. The deploy job runs under a `bark-worker-production` environment; add
environment-scoped overrides there only if you want this Worker to deploy
with different credentials than the others.

Before the first deploy, a human needs to create the D1 database and wire
its id into `servers/bark-worker/wrangler.jsonc` (this can't be scripted
from inside a sandboxed agent session):

```bash
cd servers/bark-worker
npx wrangler d1 create database-bark
```

Copy the printed `database_id` into the `d1_databases[0].database_id`
field in `wrangler.jsonc` (currently `<unique-ID-for-your-database>`) and
commit it. `npm run deploy` runs `wrangler d1 migrations apply
database --remote` as a `predeploy` step, so the schema is created
automatically on first deploy once the database is wired up.

## Connecting from Claude

Once deployed, add it as a **custom connector**:

1. claude.ai → Settings → Connectors → Add custom connector.
2. URL: `https://<worker-name>.<your-subdomain>.workers.dev/mcp`
3. Click Connect. The Worker's default config (`wrangler.jsonc`) doesn't
   set `BASIC_AUTH`, so no authorization step is needed — set it (and
   redeploy) if you want the `/mcp` and REST endpoints protected.

The generic `/mcp` endpoint requires a `device_key` argument on every
`notify` call; `/mcp/:device_key` (device-specific) omits that requirement
since the key is taken from the URL instead.

## Local development

```bash
cd servers/bark-worker
npm install
npm test
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
```

## Updating from upstream

```bash
git subtree pull --prefix=servers/bark-worker https://github.com/cwxiaos/bark-worker.git master --squash
```

Re-check `servers/bark-worker/.github/` afterwards — an upstream pull can
bring the workflow back, and it should be removed again (or deliberately
reconciled) since this repo deploys it through its own CI.
