// Deployed entry point. Wraps the upstream Bark server (../main.js, kept
// close to cwxiaos/bark-worker so `git subtree pull` stays easy) with an
// OAuth 2.1 authorization server for its MCP endpoint:
//
// - `/mcp` and `/mcp/<device_key>` require an OAuth access token, obtained
//   through the standard MCP authorization flow claude.ai's custom connectors
//   (and other OAuth-aware MCP clients) speak: `.well-known` discovery,
//   dynamic or CIMD client registration, and a consent page gated by the
//   AUTH_TOKEN secret.
// - Every other route is Bark's own REST API (register/push/ping/...), passed
//   straight through. The iOS app and push senders authenticate the way
//   Bark always has — by device key, plus optional BASIC_AUTH.
import { checkRateLimit, handleRequest } from '../main.js'
import { createOAuthProvider } from './oauth.js'
import { errorResponse, isOAuthPath, isProtectedMcpRequest, mcpPathFor } from './oauth-helpers.js'

let cached = null

function getProvider(resourceUrl, mcpPath) {
    if (cached === null || cached.resourceUrl !== resourceUrl || cached.mcpPath !== mcpPath) {
        cached = {
            resourceUrl,
            mcpPath,
            provider: createOAuthProvider({
                resourceUrl,
                mcpPath,
                // The OAuth token already authorized this request, so Bark's
                // own Basic Auth check (meant for its REST API) is skipped
                // here — an MCP client can't send both.
                handleMcp: (request, env, ctx) => handleRequest(request, { ...env, BASIC_AUTH: undefined }, ctx),
            }),
        }
    }
    return cached.provider
}

export default {
    async fetch(request, env, ctx) {
        // Checked before anything else — no OAuth/KV lookup, no D1 query.
        const limited = await checkRateLimit(request, env)
        if (limited) return limited

        const url = new URL(request.url)
        // Decided on the path main.js routes on, not the raw one: it serves
        // MCP at both `${ROOT_PATH}mcp` and a bare `/mcp`. Only the former is
        // the provider's apiRoute; the latter falls through to its default
        // handler and gets a 404, so neither reaches main.js unauthenticated.
        if (!isProtectedMcpRequest(url.pathname, env.ROOT_PATH) && !isOAuthPath(url.pathname)) {
            return handleRequest(request, env, ctx)
        }
        const mcpPath = mcpPathFor(env.ROOT_PATH)
        // Fail closed: without the KV binding there's no way to validate a
        // token, and the MCP endpoint must never fall back to being open.
        if (!env.OAUTH_KV) {
            console.error({ event: 'oauth.misconfigured', reason: 'OAUTH_KV binding is missing' })
            return errorResponse("This server's authorization is not configured.", 503)
        }
        return getProvider(url.origin, mcpPath).fetch(request, env, ctx)
    },
}
