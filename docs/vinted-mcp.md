# vinted-mcp

`servers/vinted-mcp` is a `git subtree` import of the upstream
[andrijdavid/vinted-mcp](https://github.com/andrijdavid/vinted-mcp) project
(squashed, same pattern as `hevy-mcp`), an MCP server for searching and
comparing [Vinted](https://www.vinted.com) marketplace listings across 19
countries. `servers/vinted-mcp/worker/` adds a thin Cloudflare Worker
wrapper around it — see [its README](../servers/vinted-mcp/worker/README.md)
for how the two fit together and why a `file:..` dependency is used instead
of a plain relative import.

Two small deviations from a pristine subtree, both because the upstream repo
targets Node.js/npm distribution rather than Cloudflare Workers:

- `servers/vinted-mcp/.github/` (npm-publish CI) was removed, same treatment
  as `hevy-mcp`'s upstream `.github/`.
- `servers/vinted-mcp/package.json`'s `@modelcontextprotocol/sdk` dependency
  is pinned to the exact version `1.29.0` rather than upstream's `^1.0.0`.
  The vendored source imports deep subpaths like
  `@modelcontextprotocol/sdk/server/stdio.js` that only resolve through that
  package's wildcard `"./*"` exports entry — present through `1.29.0`, but
  absent from newer patch releases. Without pinning, a fresh `npm install`
  today (before this PR, on a fresh clone of upstream) already fails to
  resolve those imports — an upstream-independent staleness issue, not
  something this port introduced.

Like `hevy-mcp`, it needs no OAuth or per-user secrets for its default
tools — it runs in the vendored client's `http` auth mode (fetch-based
cookie/CSRF bootstrap, no browser). **Known limitation:** verified live in
production, `get_seller` is fast and reliable, but `search_items` (and the
`compare_prices`/`get_trending` tools built on it) reliably stall for
minutes and then return `429 Too Many Requests` — Vinted's anti-bot
protection appears to rate-limit Cloudflare's Worker IP ranges specifically
on its search endpoint, harder than it does the seller-profile endpoint.
Confirmed by running the identical code via `wrangler dev` from a
non-Cloudflare IP, where every tool worked. See the worker README's "Known
limitation" section for details and a possible next step (`env` auth mode
with pre-obtained cookies).

CI (`.github/workflows/deploy-vinted-mcp.yml`) deploys the Worker to
`workers.dev` on every push to `main` that touches
`servers/vinted-mcp/worker/**`, or on demand via the Actions tab
(`workflow_dispatch`).

## One-time Cloudflare + GitHub setup

Reuses the same `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` repo secrets
as `hevy-mcp` and `marktplaats-mcp` — nothing new to configure if those are
already set up. The deploy job runs under a `vinted-mcp-production`
environment; add environment-scoped overrides there only if you want this
Worker to deploy with different credentials than the others.

## Connecting from Claude

Once deployed, add it as a **custom connector**:

1. claude.ai → Settings → Connectors → Add custom connector.
2. URL: `https://<worker-name>.<your-subdomain>.workers.dev/mcp`
3. Click Connect — no authorization step (same as `marktplaats-mcp`, the
   default tools don't need per-user credentials).

## Local development

```bash
cd servers/vinted-mcp && npm install
cd worker && npm install
npm test
npm run dev      # wrangler dev
npm run deploy    # wrangler deploy
```

## Updating from upstream

```bash
git subtree pull --prefix=servers/vinted-mcp https://github.com/andrijdavid/vinted-mcp.git main --squash
```

Re-check `servers/vinted-mcp/.github/` and the `@modelcontextprotocol/sdk`
pin in `servers/vinted-mcp/package.json` afterwards — an upstream pull can
bring the workflows back or loosen the pin, and both should be re-applied
(or deliberately reconciled, e.g. if upstream has since fixed its own SDK
pin) rather than left as whatever the pull produced.
