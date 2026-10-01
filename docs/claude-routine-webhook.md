# claude-routine-webhook

`servers/claude-routine-webhook` is a tiny Cloudflare Worker that lets apps
which POST their own JSON (e.g. Talat's post-meeting
"JSON webhook" action) fire a
[Claude Code routine](https://code.claude.com/docs/en/claude-code-on-the-web).
A routine's fire endpoint only accepts `{"text": "..."}`; this Worker takes
whatever body it receives and forwards it as that `text`.

It mirrors the fire endpoint's path, so switching an app over only means
changing the host:

```
https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire
→ https://claude-routine-webhook.<your-subdomain>.workers.dev/v1/claude_code/routines/<trigger id>/fire
```

What it does per request:

- The raw request body (byte-for-byte, JSON or not) becomes `text`. An empty
  body fires the routine with just its configured prompt.
- The `Authorization: Bearer <routine token>` header is forwarded as-is. The
  Worker stores no secrets, so it can't fire anything the caller couldn't
  already fire directly.
- `anthropic-version` and `anthropic-beta` are forwarded if the caller sets
  them, otherwise default to `2023-06-01` and
  `experimental-cc-routine-2026-04-01`.
- Anthropic's response status and body are relayed back, so failures (bad
  token, a body too large for `text`, …) show up in the sending app.
- Only `POST`/`PUT` to `/v1/claude_code/routines/trig_…/fire` is proxied;
  anything else gets a 404/405/401 without touching the upstream API. A rate
  limit (30 requests/60s per IP) is applied before the upstream call.

CI (`.github/workflows/deploy-claude-routine-webhook.yml`) deploys the Worker
to `workers.dev` on every push to `main` that touches
`servers/claude-routine-webhook/**`, or on demand via the Actions tab.

## One-time setup

1. **GitHub secrets**, scoped to a `claude-routine-webhook-production`
   environment: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (the same
   "Edit Cloudflare Workers" token the other Workers use).
2. Push to `main` or run the workflow manually. The run's logs print the
   deployed `*.workers.dev` hostname.

## Configuring Talat

Settings → Exports → Post-meeting actions → JSON webhook:

- **URL:** `https://claude-routine-webhook.<your-subdomain>.workers.dev/v1/claude_code/routines/<trigger id>/fire`
- **HTTP method:** POST (PUT also works).
- **Authorization header:** `Bearer <routine token>` (the `sk-ant-oat01-…`
  token from the routine's "Call via API" trigger).
- **Custom headers:** optional; the `anthropic-version`/`anthropic-beta`
  headers are filled in by the Worker if left out.

## Local development

```bash
cd servers/claude-routine-webhook
npm install
npm test
npm run dev      # wrangler dev
```

Then e.g.:

```bash
curl -X POST http://localhost:8787/v1/claude_code/routines/<trigger id>/fire \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test meeting", "transcript": "Hello"}'
```
