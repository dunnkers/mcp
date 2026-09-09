# crawl4ai-proxy

A Cloudflare Worker that fronts the `crawl4ai-mcp` Cloud Run deployment with
a real OAuth 2.1 authorization flow, built on
[`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider)
(the same library `hevy-mcp` already uses in this account).

## Why this exists

crawl4ai-mcp itself only understands a single static `Authorization: Bearer
<token>` header (see `docs/crawl4ai-mcp.md`). claude.ai's custom-connector UI
lets you configure a manual header like that, but in practice it never
actually sends it — every request from claude.ai to crawl4ai-mcp came back
401, confirmed via Cloud Run request logs, regardless of how the header value
was formatted. claude.ai's client does, however, correctly speak standard
MCP OAuth discovery (it was already probing `.well-known/oauth-*` endpoints
on every connection attempt). This Worker implements that protocol properly:

- claude.ai discovers this Worker as an OAuth-protected resource and
  authorization server via the standard `.well-known` endpoints (handled by
  the library).
- It redirects the browser to `/authorize`, which asks for the crawl4ai API
  token once (a tiny HTML form — this is a single-user personal deployment,
  so there's no real user/consent management beyond that gate).
- On success, claude.ai receives its own OAuth access/refresh token pair. It
  never sees the real crawl4ai token.
- Every proxied MCP request (`/mcp/...`) is authenticated against that OAuth
  token, then forwarded upstream to Cloud Run with the real
  `CRAWL4AI_API_TOKEN` injected as the `Authorization` header.

## Setup

1. Create the KV namespace used to store OAuth clients/grants/tokens (already
   done for this deployment — see `wrangler.jsonc`'s `kv_namespaces` id).
2. Set the shared secret (same value as the `crawl4ai-api-token` secret in
   GCP Secret Manager for the Cloud Run deployment):
   ```bash
   npx wrangler secret put CRAWL4AI_API_TOKEN
   ```
3. Deploy: `npm run deploy` (or push to `main` — see
   `.github/workflows/deploy-crawl4ai-proxy.yml`).

## Connecting from Claude

Add it as a **custom connector** in claude.ai, using this Worker's URL
(`https://crawl4ai-proxy.<your-subdomain>.workers.dev`) as the connector URL,
with authentication set to OAuth (the default — no manual header needed).
claude.ai will redirect you through `/authorize`, where you enter the
crawl4ai API token once.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in CRAWL4AI_API_TOKEN
npm run dev
```
