# vinted-mcp (Cloudflare Worker)

Cloudflare Worker wrapper around the [`servers/vinted-mcp`](..) vendored
[andrijdavid/vinted-mcp](https://github.com/andrijdavid/vinted-mcp) MCP
server (search & compare [Vinted](https://www.vinted.com) marketplace
listings across 19 countries).

This directory contains only the Worker glue — the actual tools, API client,
and response parsers live in `../src` and are reused unmodified via a
`file:..` local dependency (see `package.json`). `src/index.ts` here does
nothing but:

1. Call the vendored `createServer()` (from `../src/index.ts`), which wires
   up all six tools, both resources, and the prompts on a raw
   `@modelcontextprotocol/sdk` `Server`.
2. Connect it to `@modelcontextprotocol/sdk`'s
   `WebStandardStreamableHTTPServerTransport` in stateless, JSON-response
   mode, and route `/mcp` requests to it.

## Why a `file:..` dependency instead of a relative import?

`../src/index.ts` lives outside this directory. Wrangler's bundler doesn't
resolve `node_modules` for files outside its own project directory, so a
plain `import ... from "../../src/index"` fails to resolve the vendored
file's own `@modelcontextprotocol/sdk` imports. Depending on `file:..` (see
`package.json`) creates a `node_modules/@andrijdavid/vinted-mcp` symlink back
to the vendored root, so `import { createServer } from
"@andrijdavid/vinted-mcp/src/index"` resolves through this project's own
`node_modules` like any other dependency.

## Auth mode

The vendored client supports three auth modes (`http`, `playwright`, `env`).
This Worker always runs in the default **`http`** mode — a fetch-only
cookie/CSRF bootstrap against Vinted's homepage, no browser required. The
**`playwright`** mode can't run in a Workers isolate (no Chromium), so it's
never selected; the vendored client's `PlaywrightAuth`/`ProfileAuth` classes
only `require()` their browser-automation dependencies lazily inside methods
that are never called this way, so they don't affect bundling.

### Known limitation: search-backed tools from Cloudflare's IP space

Tested live against production, from two different networks:

- Run locally (`wrangler dev`, egress from a normal residential/datacenter
  IP, *not* Cloudflare's), every read tool worked reliably and fast:
  `search_items`, `get_item`, `get_seller`, `compare_prices`, `get_trending`.
- Deployed to the actual Worker (egress from Cloudflare's shared IP range),
  `get_seller` is still reliably fast (~2s) — but `search_items` (and by
  extension `compare_prices`/`get_trending`, which call the same underlying
  search endpoint) reliably stalled for 1-2+ minutes and then surfaced
  `429 Too Many Requests`, or timed out client-side before that. `get_item`
  can similarly fall back to the vendored client's own "(All fetch methods
  failed)" partial-data stub.

This isn't a bug in the port — the vendored client's `http`-mode session
bootstrap and API calls are byte-for-byte the same code either way, verified
working end-to-end. Vinted's anti-bot protection on its search endpoint
appears to specifically rate-limit or challenge Cloudflare's well-known
Worker egress ranges harder than its seller-profile endpoint does. The
client's own retry/backoff logic (up to 3 retries with growing waits) is why
a blocked call takes minutes instead of failing fast — it isn't hung.

If this matters for your use case, the vendored client also supports an
`env` auth mode (pre-obtained cookies/tokens via `VINTED_AUTH_*`) which
isn't wired up as Worker secrets here, and would sidestep the per-request
bootstrap that's triggering the block; that's a reasonable next step if
`search_items` needs to be reliable from this Worker specifically.

`like_item` needs a logged-in session (`env` auth mode with `VINTED_AUTH_*`
vars set as Worker secrets), which isn't configured here either.

## Development

```bash
(cd .. && npm install)   # the vendored root needs its own node_modules too —
                          # `file:..` only symlinks the package, it doesn't
                          # install its dependencies for you
npm install
npm test           # vitest — routing + full MCP protocol round trip, no network
npm run dev         # wrangler dev
npm run deploy       # wrangler deploy
```

See [`docs/vinted-mcp.md`](../../../docs/vinted-mcp.md) at the repo root for
deployment and connector setup.
