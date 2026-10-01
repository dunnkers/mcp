# marktplaats-mcp

An MCP (Model Context Protocol) server for searching and browsing
[Marktplaats.nl](https://www.marktplaats.nl) listings, deployed here as a
Cloudflare Worker. It's a from-scratch TypeScript port of the
[Python `marktplaats-mcp` server](https://github.com/dunnkers/marktplaats-mcp)
— same tools and behavior, running on Cloudflare's edge instead of as a local
stdio process, so it has effectively no idle cost and no local Python
dependency to install.

It's stateless and read-only: no per-user state, no upstream API key. Every
request creates a fresh in-memory MCP server, calls the public Marktplaats
search/listing endpoints, and returns the result.

## Auth

`/mcp` is protected by a real OAuth 2.1 flow, built on
[`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider)
(the same library `hevy-mcp` and `vinted-mcp` already use in this
account). This Worker's `*.workers.dev` URL is public — it's printed in
deploy logs and derivable from the repo — so anonymous access has to be
denied at the edge rather than relying on the URL being secret. A client
(claude.ai's custom-connector UI, or any other OAuth-aware MCP client)
discovers the Worker via the standard `.well-known` endpoints, is redirected
to `/authorize` to enter the `AUTH_TOKEN` once, and from then on authenticates
with its own OAuth access token — never the shared token itself. Requests to
`/mcp` without a valid token are rejected before the MCP server (or any
Marktplaats request) ever runs.

The consent page only issues a grant to an authorization code request that
has S256 PKCE and a redirect back to `claude.ai`, `claude.com` or a loopback
address (override with the `ALLOWED_REDIRECT_HOSTS` var), and it shows the
redirect host before you enter the token. See
[`docs/auth.md`](../../docs/auth.md) for the full scheme shared by every
server in this repo.

### Setup

1. Reuse the account's existing OAuth KV namespace (same one `hevy-mcp`
   and `vinted-mcp` use) — `wrangler.jsonc` commits a placeholder id
   (`00000000000000000000000000000000`); the deploy workflow substitutes the
   real id from the `CLOUDFLARE_OAUTH_KV_NAMESPACE_ID` repository variable
   before running `wrangler deploy`. To deploy manually instead, substitute it
   yourself and restore the placeholder afterward (run the same `sed`
   the deploy workflow does, then `git checkout wrangler.jsonc`).
2. Set the consent-page password. It must be at least 32 characters, or
   `/authorize` refuses to run:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
   ```
3. Deploy: `npm run deploy` (or push to `main` — see
   `.github/workflows/deploy-marktplaats-mcp.yml`).

## Tools

- `search_listings` — search listings by query, category, price, condition,
  seller type, etc. Supports a `compact: true` mode that trims the response
  to ~25% of its normal size (drops description/image/links) for
  context-constrained use.
- `get_listing_details` — full listing detail (description, images,
  attributes, view/save stats) scraped from the public listing page.
- `get_seller_info` — a seller's rating and verification status.
- `list_categories` — main categories and common subcategories, with the IDs
  `search_listings` accepts.
- `get_category_filters` — the attribute filters (RAM, brand, screen size,
  ...) available for a category, for use with `search_listings`'
  `attribute_ids`.

## Development

```bash
npm install
npm test          # vitest unit + integration tests (mocked fetch)
npm run check:types
npm run dev        # wrangler dev, serves on http://localhost:8787
npm run deploy      # wrangler deploy
```

`src/` is organized as:

- `constants.ts` — category IDs, headers, enums (ported 1:1 from the Python
  source).
- `format.ts` — pure formatting/parsing helpers (price, seller type, date,
  condition, spec extraction). The most heavily unit-tested part.
- `html.ts` — lightweight HTML-to-text and JSON-LD extraction, used to parse
  the listing detail page (no DOM library — just enough regex-based parsing
  to replicate what the original's BeautifulSoup-based scraping did).
- `api.ts` — the five tool implementations, calling Marktplaats' public
  `lrp/api/search` and `v/api/seller-profile` endpoints directly.
- `server.ts` — registers the tools on an `@modelcontextprotocol/sdk`
  `McpServer` with zod input schemas.
- `mcp-handler.ts` — mounts the MCP server on a single request using the
  SDK's `WebStandardStreamableHTTPServerTransport` in stateless, JSON-response
  mode (no Durable Objects, no session state).
- `oauth-helpers.ts` / `oauth.ts` — the OAuth 2.1 authorization server (see
  [Auth](#auth) below) that gates access to `mcp-handler.ts`.
- `index.ts` — the Worker's `fetch` handler: wires the OAuth provider up,
  routing authorized `/mcp` requests to `mcp-handler.ts`.

See [`docs/marktplaats-mcp.md`](../../docs/marktplaats-mcp.md) at the repo
root for deployment and connector setup.
