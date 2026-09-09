# crawl4ai-mcp

Deploys the official [`unclecode/crawl4ai`](https://hub.docker.com/r/unclecode/crawl4ai)
Docker image — which bundles its own MCP endpoint — straight to
[Cloud Run](https://cloud.google.com/run), pulled directly from Docker Hub.
There is no vendored source in this repo for this one: nothing to build, the
public image is deployed as-is, and this repo only owns the deploy config
(`.github/workflows/deploy-crawl4ai-mcp.yml`) and this doc.

Unlike the other servers here (all Cloudflare Workers), Crawl4AI needs a real
container with a headless Chromium, so it runs on Cloud Run instead. Deployed
with `--min-instances=0` / `--max-instances=1`: cold starts are accepted
(first request after idle pays browser boot time), and there is deliberately
no cross-restart session/login persistence — every request is stateless. See
the chat history / commit context for the reasoning if you need to revisit
either tradeoff.

Authentication is two separate layers:

- **Cloud Run IAM** — the service is deployed `--allow-unauthenticated` so
  ordinary MCP clients (which don't speak Google OIDC) can reach it.
- **Crawl4AI's own app-level token** (`CRAWL4AI_API_TOKEN`) — this is the
  real gate. Every request must carry `Authorization: Bearer <token>`. The
  token lives in Secret Manager, never in GitHub or in this repo, and is
  injected into the container at deploy time via `--set-secrets`.

## One-time GCP setup (console)

Do this once, in the Google Cloud Console, in the project you want to host
this in.

1. **Note your project ID and number** — Cloud Console home page (the
   project picker dropdown shows the ID; the number is on the same
   dashboard's "Project info" card).

2. **Enable APIs** — APIs & Services → Library, enable:
   - Cloud Run Admin API
   - IAM Service Account Credentials API
   - Secret Manager API

3. **Create two service accounts** — IAM & Admin → Service Accounts → Create
   Service Account:
   - `github-deployer` — used by CI to run the deploy. Grant it, at the
     project level (IAM & Admin → IAM → Grant Access):
     - `Cloud Run Admin` (`roles/run.admin`)
     - `Service Account User` (`roles/iam.serviceAccountUser`) — needed so
       it can deploy a service that runs as the *other* service account
       below.
   - `crawl4ai-runtime` — the identity the Cloud Run service itself runs as
     (kept separate from the deployer, least privilege). No project-level
     roles needed yet — it gets a narrow, resource-level grant in step 5.

4. **Create the Workload Identity Federation pool** — IAM & Admin →
   Workload Identity Federation → Create Pool:
   - Pool name: `github-pool`
   - Add a provider → OIDC:
     - Provider name: `github-provider`
     - Issuer URL: `https://token.actions.githubusercontent.com`
     - Attribute mapping: `google.subject = assertion.sub`,
       `attribute.repository = assertion.repository`,
       `attribute.ref = assertion.ref`
     - Attribute condition (restricts this to *this* repo only):
       `assertion.repository == 'dunnkers/mcp'`
   - After creating it, open the pool, click "Grant Access", select the
     `github-deployer` service account, and choose "All identities in the
     pool" filtered by the attribute condition above (or paste the
     principalSet directly — the console shows it, and it looks like
     `principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-pool/attribute.repository/dunnkers/mcp`).
   - Note the **provider resource name** shown on the provider's details
     page (`projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-pool/providers/github-provider`)
     — you'll need it for a GitHub secret below.

5. **Create the app-level auth token as a secret** — generate a strong
   random value locally (e.g. `openssl rand -hex 32`), then Secret Manager →
   Create Secret:
   - Name: `crawl4ai-api-token`
   - Secret value: the generated token
   - After creating it, grant both `crawl4ai-runtime` and `github-deployer`
     the `Secret Manager Secret Accessor` role on this specific secret
     (Secret Manager → the secret → Permissions → Grant Access) — the
     deployer needs it too, since `gcloud run deploy` resolves the secret
     reference at deploy time.
   - Save the token value somewhere safe (e.g. your password manager) — it's
     what you'll put in `Authorization: Bearer <token>` when calling the
     deployed service, same as the local Docker setup.

## One-time GitHub setup

Repo → Settings → Environments → New environment → name it
`crawl4ai-mcp-production` (matches the naming the other deploy workflows
use), then add these as environment secrets:

| Secret | Value |
| --- | --- |
| `GCP_PROJECT_ID` | your project ID |
| `GCP_REGION` | e.g. `us-central1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | the provider resource name from step 4 above |
| `GCP_DEPLOYER_SA_EMAIL` | `github-deployer@<PROJECT_ID>.iam.gserviceaccount.com` |
| `GCP_RUNTIME_SA_EMAIL` | `crawl4ai-runtime@<PROJECT_ID>.iam.gserviceaccount.com` |

Note `CRAWL4AI_API_TOKEN` itself is deliberately **not** a GitHub secret —
it only ever lives in Secret Manager and is wired into the container at
deploy time by reference (`--set-secrets`), so it never passes through CI.

## Deploying

CI (`.github/workflows/deploy-crawl4ai-mcp.yml`) deploys on every push to
`main` that touches the workflow file or this doc, or on demand via the
Actions tab (`workflow_dispatch`). To redeploy after bumping the pinned
image tag (`env.IMAGE` in the workflow) to a newer Crawl4AI release, just
push the change to main — the `paths` filter matches the workflow file
itself, so it triggers automatically.

## Connecting from Claude

Add it as a **custom connector**:

1. claude.ai → Settings → Connectors → Add custom connector.
2. URL: `https://<cloud-run-service-url>/mcp` (the workflow logs print the
   service URL after deploy; also visible in Cloud Run console).
3. Authorization header: `Bearer <the crawl4ai-api-token value>`.

## Local development

See the `crawl4ai` skill / chat history for the local Docker Desktop
equivalent (`docker run ... -e CRAWL4AI_API_TOKEN=... unclecode/crawl4ai`) —
useful for testing schema/extraction strategies before pointing them at the
deployed service.
