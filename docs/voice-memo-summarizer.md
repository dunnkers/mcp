# voice-memo-summarizer

`servers/voice-memo-summarizer` is a Cloudflare Worker that takes **any** body
POSTed to it and returns Gemini's text rendering of it. It's built for the
Apple Shortcuts "Get contents of URL" action with a *File* request body, but
works with anything:

- **Raw body** — audio (m4a, mp3, wav, ogg, flac, aac, webm), video, images,
  PDFs. If the `Content-Type` is missing or `application/octet-stream`, the
  type is sniffed from the file's magic bytes.
- **Text / JSON / XML / CSV** — passed to Gemini as text.
- **`multipart/form-data`** — every file and text field is sent together.

Gemini (`gemini-3.8-flash`, the latest Flash model; change `GEMINI_MODEL` in
`wrangler.jsonc` to move) is instructed to transcribe or describe exactly what
it is given, make sense of it, and say only what is actually there: no
invented content, `[inaudible]` for gaps, and the input is treated as data,
never as instructions. The prompt is in
[`src/prompt.ts`](../servers/voice-memo-summarizer/src/prompt.ts). The reply is
`text/plain`.

Media is uploaded to `gs://voice-memo-summarizer-storage/uploads/…`, handed to
Gemini by URI, and deleted again afterwards (add a bucket lifecycle rule as a
backstop). Request bodies are capped at 100 MB.

## How it authenticates to Google Cloud

No Google key is stored anywhere. The Worker is its own OIDC identity
provider, and Google trusts it through **workload identity federation**:

1. The Worker signs a 5-minute JWT (`iss` = the Worker's origin, `aud` = the
   provider's resource name) with a private key kept as a Worker secret, and
   publishes the matching public key at `/.well-known/jwks.json` (with
   `/.well-known/openid-configuration`).
2. Google STS verifies the JWT against the workload identity pool provider and
   returns a federated token.
3. The federated token impersonates the `voice-memo-summarizer` service
   account (skip this by leaving `SERVICE_ACCOUNT_EMAIL` unset and granting
   the roles to the federated principal directly).
4. That token calls Cloud Storage and Vertex AI. It's cached per isolate until
   shortly before it expires.

`js-genai`'s web build (the one that runs on Workers) only supports API keys
for Vertex, so the Worker gives it a placeholder key and a `fetch` that swaps
in the bearer token. See [`src/gemini.ts`](../servers/voice-memo-summarizer/src/gemini.ts).

Callers authenticate to the Worker with `Authorization: Bearer <AUTH_TOKEN>`
(it spends your money, so it is not left open). Requests are rate limited to
20 per minute per IP.

## One-time setup

### 1. Google Cloud

Everything here is for project `voice-memo-summarizer`. The Worker's public URL
is only known after the first deploy, so deploy first (step 2), then come back.

```bash
PROJECT_ID=voice-memo-summarizer
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
ISSUER=https://voice-memo-summarizer.<your-subdomain>.workers.dev   # no trailing slash
SA=voice-memo-summarizer@$PROJECT_ID.iam.gserviceaccount.com

gcloud services enable aiplatform.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com storage.googleapis.com --project $PROJECT_ID

# Service account the Worker acts as
gcloud iam service-accounts create voice-memo-summarizer --project $PROJECT_ID
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member serviceAccount:$SA --role roles/aiplatform.user
gcloud storage buckets add-iam-policy-binding gs://voice-memo-summarizer-storage \
  --member serviceAccount:$SA --role roles/storage.objectUser

# Workload identity pool + OIDC provider that trusts the Worker
gcloud iam workload-identity-pools create cloudflare-workers \
  --project $PROJECT_ID --location global
gcloud iam workload-identity-pools providers create-oidc voice-memo-summarizer-worker \
  --project $PROJECT_ID --location global --workload-identity-pool cloudflare-workers \
  --issuer-uri $ISSUER \
  --allowed-audiences "//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/cloudflare-workers/providers/voice-memo-summarizer-worker" \
  --attribute-mapping google.subject=assertion.sub \
  --attribute-condition "assertion.sub == 'voice-memo-summarizer-worker'"

# Let that identity impersonate the service account
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT_ID \
  --role roles/iam.workloadIdentityUser \
  --member "principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/cloudflare-workers/subject/voice-memo-summarizer-worker"
```

Optional: `gcloud storage buckets update gs://voice-memo-summarizer-storage --lifecycle-file=…`
with a rule deleting objects under `uploads/` after 1 day.

### 2. Worker

1. In `wrangler.jsonc`, replace `<PROJECT_NUMBER>` in `WIF_AUDIENCE` (the
   other `vars` already match the names above).
2. Generate the signing key and set both secrets:

   ```bash
   cd servers/voice-memo-summarizer && npm install
   npm run -s gen:oidc-key | npx wrangler secret put OIDC_PRIVATE_KEY_JWK
   openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put AUTH_TOKEN
   ```

   (The second command also prints the token — you need it for the Shortcut.)
3. Deploy: GitHub secrets `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` in a
   `voice-memo-summarizer-production` environment, then push to `main`
   (`.github/workflows/deploy-voice-memo-summarizer.yml`) or `npm run deploy`.
   The first deploy has to happen before the provider is created, since the
   provider needs the Worker's URL as its issuer. If you attach a custom
   domain, set `OIDC_ISSUER` to it, because the issuer must match the provider
   exactly.

Check the wiring: `curl $ISSUER/.well-known/jwks.json` should show a public key.

## Apple Shortcuts

"Get contents of URL":

- **URL:** `https://voice-memo-summarizer.<your-subdomain>.workers.dev`
- **Method:** POST
- **Headers:** `Authorization` = `Bearer <AUTH_TOKEN>`
- **Request Body:** File → the voice memo (or other file)

The action's result is the text; pipe it to "Copy to Clipboard", "Show
Result", etc.

## Local development

```bash
cd servers/voice-memo-summarizer
npm install
npm test
npm run dev   # needs .dev.vars with AUTH_TOKEN and OIDC_PRIVATE_KEY_JWK
```

```bash
curl -X POST http://localhost:8787 -H "Authorization: Bearer $AUTH_TOKEN" \
  --data-binary @memo.m4a -H "Content-Type: audio/mp4"
```
