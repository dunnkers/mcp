# marktplaats-mcp

`servers/marktplaats-mcp` is a from-scratch TypeScript port of the Python
[dunnkers/marktplaats-mcp](https://github.com/dunnkers/marktplaats-mcp)
server (search and browse [Marktplaats.nl](https://www.marktplaats.nl)
listings), deployed here as a Cloudflare Worker so it has effectively no idle
cost and low cold-start latency. Unlike `hevy-mcp`, it isn't a `git subtree`
of an upstream repo — there was no existing TypeScript implementation to
import, so it's maintained directly in this repo.

It needs no secrets or bindings: it's a stateless, read-only wrapper around
Marktplaats' public search API, so there's no OAuth flow and no API key to
configure.

CI (`.github/workflows/deploy-marktplaats-mcp.yml`) deploys the Worker to
`workers.dev` on every push to `main` that touches
`servers/marktplaats-mcp/**`, or on demand via the Actions tab
(`workflow_dispatch`).

## One-time Cloudflare + GitHub setup

This needs doing once, by a human with access to both accounts.

1. **Cloudflare API token.** Reuse the same "Edit Cloudflare Workers" token
   used for `hevy-mcp` (Account: Workers Scripts:Edit), or create a new one.
2. **GitHub repo secrets** (Settings → Secrets and variables → Actions →
   Secrets), scoped to a `marktplaats-mcp-production` environment:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
3. Push to `main` (e.g. merge the PR that added this server) or run the
   workflow manually from the Actions tab. The run's logs print the deployed
   `*.workers.dev` hostname.

## Connecting from Claude

Once deployed, add it as a **custom connector**:

1. claude.ai → Settings → Connectors → Add custom connector.
2. URL: `https://<worker-name>.<your-subdomain>.workers.dev/mcp`
3. Click Connect — no authorization step, since there's nothing to
   authenticate (the server doesn't touch any private data).

## Local development

```bash
cd servers/marktplaats-mcp
npm install
npm test
npm run dev      # wrangler dev
npm run deploy    # wrangler deploy (needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
```
