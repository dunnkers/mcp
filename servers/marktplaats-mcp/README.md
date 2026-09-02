# marktplaats-mcp

An MCP (Model Context Protocol) server for searching and browsing
[Marktplaats.nl](https://www.marktplaats.nl) listings, deployed here as a
Cloudflare Worker. It's a from-scratch TypeScript port of the
[Python `marktplaats-mcp` server](https://github.com/dunnkers/marktplaats-mcp)
— same tools and behavior, running on Cloudflare's edge instead of as a local
stdio process, so it has effectively no idle cost and no local Python
dependency to install.

It's stateless and read-only: no API key, no auth, no per-user state. Every
request creates a fresh in-memory MCP server, calls the public Marktplaats
search/listing endpoints, and returns the result.

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
- `index.ts` — the Worker's `fetch` handler: mounts the MCP server at `/mcp`
  using the SDK's `WebStandardStreamableHTTPServerTransport` in stateless,
  JSON-response mode (no Durable Objects, no session state).

See [`docs/marktplaats-mcp.md`](../../docs/marktplaats-mcp.md) at the repo
root for deployment and connector setup.
