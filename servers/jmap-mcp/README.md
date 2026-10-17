# jmap-mcp

An MCP server for managing an email account over
[JMAP](https://jmap.io), deployed as a Cloudflare Worker. Today it covers
**Sieve filter scripts** ([RFC 9661](https://www.rfc-editor.org/rfc/rfc9661)),
the out-of-office auto-reply and storage quota. It deliberately has **no tools
that read mail**. The client is a small `fetch`-based JMAP client
(`src/jmap.ts`), so more JMAP tools can be added later without new dependencies.

Nothing about the mail provider is in this repo. The server is pointed at any
JMAP server with Worker secrets, and authenticates with HTTP Basic (an app
password).

## Tools

| Tool | What it does |
| --- | --- |
| `sieve_get_capabilities` | Account limits (max size/count/redirects, extensions) and this server's policy |
| `sieve_list_scripts` | Script ids, names and which one is active |
| `sieve_get_script` | Source of a script |
| `sieve_validate_script` | Grammar and policy check without saving |
| `sieve_put_script` | Create or replace a script (validated, never activated). Replacing the active script needs `confirm_update_active`. Returns the previous content |
| `sieve_activate_script` | Make a script the active one (re-checked against the policy) |
| `sieve_deactivate_script` | Turn off the active script |
| `sieve_rename_script` | Rename a script |
| `sieve_delete_script` | Delete a script. The active one needs `deactivate_if_active`. Returns the deleted content |
| `vacation_get` / `vacation_set` | Read / update the out-of-office auto-reply |
| `get_quota` | Storage quota |

Write tools are annotated `destructiveHint`, so clients like claude.ai ask
before running them.

## Configuration

Set from the Worker's directory (`wrangler secret put`) or in the Cloudflare
dashboard. None of it is committed.

| Name | Kind | Meaning |
| --- | --- | --- |
| `JMAP_SESSION_URL` | secret | The server's JMAP session URL, usually `https://<host>/.well-known/jmap` (redirects are followed within the same origin) |
| `JMAP_USERNAME` | secret | Login |
| `JMAP_PASSWORD` | secret | App password. Use a dedicated one with an expiry |
| `AUTH_TOKEN` | secret | Consent-page password, see [auth.md](../../docs/auth.md) |
| `DENY_SIEVE_ACTIONS` | var, optional | Comma-separated Sieve actions/extensions scripts may not use. Default `redirect,notify`. Set it to `none` (or empty) to allow everything |
| `READ_ONLY` | var, optional | `true` registers only the read tools |

`keep_vars` is on in `wrangler.jsonc`, so variables set in the dashboard
survive deploys.

### Why `redirect` and `notify` are denied by default

A Sieve `redirect` forwards a copy of mail elsewhere, and `notify` (enotify)
can mail out message text. A wrong or injected script could silently leak
password resets and 2FA codes, and keeps doing so after the chat ends. The
check runs on `sieve_put_script`, `sieve_validate_script` and
`sieve_activate_script`. It is a best-effort lint (comments, strings and
`text:` blocks are ignored; `require`d extensions are checked), not a security
boundary. To forbid more, list them, e.g. `redirect,notify,reject,ereject,editheader`.

## Credential safety

The login is sent only to the origin of `JMAP_SESSION_URL`. Redirects and the
`apiUrl` / `uploadUrl` / `downloadUrl` in the session document must stay on
that origin, or the request is refused. Errors shown to the client never
contain credentials.

## Known unknowns

Tested against an in-memory fake JMAP server only. Check against the real
account before relying on it: updating a script in place, the two-step delete
of an active script, the exact `invalidSieve` error shape, and whether the
server implements `VacationResponse` and `Quota` for normal users.

## Local development

```bash
cd servers/jmap-mcp
npm install
npm test
npm run dev      # wrangler dev; put secrets in .dev.vars
```
