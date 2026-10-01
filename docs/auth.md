# Auth

Every MCP endpoint in this repo sits behind OAuth 2.1, implemented with
[`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider).
It's the standard MCP authorization flow that claude.ai custom connectors use
(and Claude Code, Claude Desktop, and any other OAuth-aware MCP client). Each
Worker's `*.workers.dev` URL is public: it's printed in deploy logs and can be
worked out from this repo. So access is enforced at the edge, not by keeping
the URL secret.

| Server | What `/authorize` asks for | What the grant carries |
| --- | --- | --- |
| `hevy-mcp` | Your Hevy API key (validated against Hevy) | The key, encrypted into the grant |
| `marktplaats-mcp` | The Worker's `AUTH_TOKEN` | Nothing (upstream API is public) |
| `vinted-mcp` | The Worker's `AUTH_TOKEN` | Nothing (upstream API is public) |
| `bark-worker` | The Worker's `AUTH_TOKEN` | Nothing (device keys are passed per call) |

## How a client connects

1. The client calls `/mcp` and gets `401` with a
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`
   header.
2. It reads the protected-resource metadata (RFC 9728) and the
   authorization-server metadata (RFC 8414).
3. It identifies itself in one of two ways. claude.ai uses a client ID
   metadata document (CIMD), where the `client_id` is
   `https://claude.ai/oauth/mcp-oauth-client-metadata`. Other clients use
   dynamic client registration (RFC 7591).
4. The browser opens the Worker's consent page. It names the client and the
   host the grant will be sent back to. You enter the credential once.
5. The client exchanges the code, using PKCE (S256), for an access token
   (valid 7 days) and a refresh token (valid 30 days). It never sees the
   underlying credential.

## Hardening shared by all four Workers

- **PKCE S256 is required.** The library only checks PKCE when a code
  challenge is sent, so the consent page rejects requests without one.
- **Tokens are bound to their audience.** Each Worker sets
  `resourceMetadata.resource` to its own origin, so every token is bound to
  that Worker (RFC 8707). A token minted by one Worker is rejected by the
  others, even though they share a KV namespace.
- **Grant user IDs are distinct.** `completeAuthorization` revokes a user's
  existing grants for the same client, and claude.ai uses one client ID for
  every connector. The shared-password Workers therefore issue grants to a
  per-Worker user ID (`<worker>-owner`), so connecting one server can't
  disconnect another.
- **Rate limiting runs first.** Each Worker allows 60 requests per 60 seconds
  per IP, checked before any KV, D1 or upstream work. Each Worker has its own
  rate-limit namespace, because those IDs are account-wide.
- **CIMD needs a compatibility flag.** CIMD requires the
  `global_fetch_strictly_public` flag, which also stops outbound fetches from
  reaching private addresses.

Two further protections apply to the shared-password Workers (`marktplaats-mcp`,
`vinted-mcp` and `bark-worker`):

- **Redirect allowlist.** A grant can only be sent back to `claude.ai`,
  `claude.com` or a loopback address (`localhost`, `127.0.0.1`, `[::1]`, used
  by desktop and CLI clients). Without this, anyone could register a client
  whose `redirect_uri` they control, send you a link to the real consent page,
  and receive the grant. To allow other clients, set the
  `ALLOWED_REDIRECT_HOSTS` var to a comma-separated list.
- **Fail closed.** The consent page returns `503` until `AUTH_TOKEN` is set to
  at least 32 characters. bark-worker also returns `503` on `/mcp` if the
  `OAUTH_KV` binding is missing, rather than serving the endpoint
  unauthenticated.

`hevy-mcp` doesn't need either one. Its consent page asks for your own Hevy
key, and no shared secret is involved, so it accepts any redirect a client
registers (ChatGPT's connector included).

## Setup for a shared-password Worker

1. **KV namespace.** Every Worker reuses the account's OAuth KV namespace.
   Deploy workflows substitute its ID from the
   `CLOUDFLARE_OAUTH_KV_NAMESPACE_ID` repository **variable**, falling back
   to a secret with the same name, and fail if neither is set.
2. **Consent password:**
   ```bash
   openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
   ```
   Run this from the Worker's directory, and keep the value in your password
   manager.
3. **Connect:** claude.ai → Settings → Connectors → Add custom connector →
   `https://<worker>.<subdomain>.workers.dev/mcp` → Connect. Then enter the
   `AUTH_TOKEN` on the consent page.

To revoke access, rotate `AUTH_TOKEN`; this stops new grants. To end existing
sessions immediately as well, delete the Worker's `grant:<worker>-owner:*` and
`token:<worker>-owner:*` keys from the KV namespace.
