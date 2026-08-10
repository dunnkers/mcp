# hevy-mcp (self-hosted)

`servers/hevy-mcp` is a `git subtree` import of the upstream
[chrisdoc/hevy-mcp](https://github.com/chrisdoc/hevy-mcp) project (squashed,
so this repo's history stays clean). It's an MCP server for the
[Hevy](https://www.hevyapp.com/) workout app, deployed here as a Cloudflare
Worker so it has effectively no idle cost and low cold-start latency.

CI (`.github/workflows/deploy-hevy-mcp.yml`) deploys the Worker to
`workers.dev` on every push to `main` that touches `servers/hevy-mcp/**`, or
on demand via the Actions tab (`workflow_dispatch`). The upstream repo's own
CI/release automation (`servers/hevy-mcp/.github/`) was intentionally removed
— it assumes chrisdoc's npm-publish/changesets/Docker pipeline, which doesn't
apply to a personal self-hosted fork.

## One-time Cloudflare + GitHub setup

This needs doing once, by a human with access to both accounts — nothing here
can be scripted from inside a sandboxed agent session.

1. **Cloudflare API token.** In the Cloudflare dashboard, create an API token
   with the "Edit Cloudflare Workers" template (Account: Workers Scripts:Edit,
   Zone: n/a since we're using `workers.dev`, not a custom domain).
2. **GitHub repo secrets** (Settings → Secrets and variables → Actions →
   Secrets):
   - `CLOUDFLARE_API_TOKEN` — the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID` — found on the right sidebar of the Cloudflare
     dashboard overview page.
3. **GitHub repo variable** (same page, "Variables" tab):
   - `CLOUDFLARE_OAUTH_KV_NAMESPACE_ID` — a KV namespace to store OAuth
     grants, so Claude.ai (including mobile) can connect without you pasting a
     bearer token into every client. One was already created for this repo:

     ```text
     b2e970b7d50442e1ac1e920298ef71e1   (title: hevy-mcp-oauth)
     ```

     If you'd rather use a different namespace, create one with
     `npx wrangler kv namespace create OAUTH_KV` from `servers/hevy-mcp` and
     use its id instead.

   This variable **must** be set before the first deploy — the Worker config
   only wires up the `OAUTH_KV` binding when it sees a non-empty value.
4. Push to `main` (e.g. merge this PR) or run the workflow manually from the
   Actions tab. The run's logs print the deployed `*.workers.dev` hostname.

No `HEVY_API_KEY` secret is needed on the Worker itself — it's stateless and
takes the key per-request (either as a direct bearer token, or once through
the OAuth `/authorize` flow, encrypted into the OAuth grant).

## Connecting from Claude

Once deployed, add it as a **custom connector**:

1. claude.ai → Settings → Connectors → Add custom connector.
2. URL: `https://<worker-name>.<your-subdomain>.workers.dev/mcp`
3. Click Connect → you'll be sent through the Worker's `/authorize` page →
   paste your Hevy API key (requires Hevy PRO) → it's validated against Hevy
   and stored encrypted in the OAuth grant, not on the Worker.
4. Same connector works from the Claude mobile app once added on the web/desktop
   account settings — it syncs per-account, not per-device.

If `/authorize` ever says "Invalid authorization request", it means the
Worker doesn't have the `OAUTH_KV` binding wired up (step 3 above wasn't done
before deploying) — redeploy after setting the repo variable.

## Updating from upstream

```bash
git subtree pull --prefix=servers/hevy-mcp https://github.com/chrisdoc/hevy-mcp.git main --squash
```

Re-check `servers/hevy-mcp/.github/` afterwards — an upstream pull will bring
its workflows back, and they should be removed again (or deliberately
reconciled) since this fork doesn't run chrisdoc's release pipeline.
