# jmap-mcp

`servers/jmap-mcp` is a Cloudflare Worker MCP server that manages an email
account over JMAP: Sieve filter scripts (RFC 9661), the out-of-office
auto-reply and storage quota. It has no tools that read mail. The mail
provider is not named anywhere in the repo; the JMAP server and login are
Worker secrets. Tools, configuration and the safety model are in the
[server README](../servers/jmap-mcp/README.md).

`/mcp` is behind the same OAuth 2.1 shared-password gate as the other Workers;
see [auth.md](auth.md). The grant carries nothing, because the JMAP login
lives in Worker secrets.

CI (`.github/workflows/deploy-jmap-mcp.yml`) deploys the Worker on every push to
`main` that touches `servers/jmap-mcp/**`, or on demand (`workflow_dispatch`).

## One-time setup

1. **GitHub:** an environment `jmap-mcp-production` with the
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets (same values as
   the other Workers), and the `CLOUDFLARE_OAUTH_KV_NAMESPACE_ID` repository
   variable, as in [auth.md](auth.md#setup-for-a-shared-password-worker).
2. **Deploy once** (push to `main` or run the workflow) so the Worker exists.
3. **Secrets**, from `servers/jmap-mcp`:
   ```bash
   openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
   npx wrangler secret put JMAP_SESSION_URL   # https://<host>/.well-known/jmap
   npx wrangler secret put JMAP_USERNAME
   npx wrangler secret put JMAP_PASSWORD      # a dedicated app password
   ```
   Optional vars `DENY_SIEVE_ACTIONS` and `READ_ONLY` can be set in the
   dashboard (Worker → Settings → Variables).
4. **Connect:** claude.ai → Settings → Connectors → Add custom connector →
   `https://jmap-mcp.<subdomain>.workers.dev/mcp`, then enter `AUTH_TOKEN`.

Create the app password with the narrowest permissions and an expiry your
provider offers. IP allowlists don't work, since Worker egress IPs aren't
stable.
