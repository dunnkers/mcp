import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import {
    AUTHORIZE_PATH,
    authRequestProblem,
    decodeAuthRequest,
    encodeAuthRequest,
    errorResponse,
    htmlResponse,
    isUsableAuthToken,
    MIN_AUTH_TOKEN_LENGTH,
    parseAllowedRedirectHosts,
    redirectHostForDisplay,
    REGISTER_PATH,
    renderAuthorizePage,
    TOKEN_PATH,
    tokensMatch,
} from './oauth-helpers.js'

// One-hour access tokens would make claude.ai refresh several times a day,
// and every refresh writes to KV. This is a single-user personal deployment,
// so a long-lived session is fine and keeps well under KV's free-plan write
// quota (same reasoning as marktplaats-mcp's and hevy-mcp's OAuth wiring in
// this repo, which run the same library against the same Cloudflare account).
const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

// The single user every grant is issued to. Must be unique per Worker: the
// OAuth KV namespace is shared with this repo's other Workers, grants live
// under `grant:<userId>:`, and completeAuthorization revokes the user's
// existing grants for the same client — and claude.ai uses one client id for
// every connector. A shared userId would make connecting one server silently
// disconnect the others.
const GRANT_USER_ID = 'bark-worker-owner'

function misconfiguredResponse() {
    console.error({
        event: 'oauth.misconfigured',
        reason: `AUTH_TOKEN is unset or shorter than ${MIN_AUTH_TOKEN_LENGTH} characters`,
    })
    return errorResponse("This server's authorization is not configured.", 503)
}

async function handleAuthorizeGet(request, env, helpers) {
    if (!isUsableAuthToken(env.AUTH_TOKEN)) return misconfiguredResponse()
    let authRequest
    try {
        authRequest = await helpers.parseAuthRequest(request)
    } catch {
        return errorResponse('Invalid authorization request.', 400)
    }
    const problem = authRequestProblem(authRequest, parseAllowedRedirectHosts(env.ALLOWED_REDIRECT_HOSTS))
    if (problem) return errorResponse(problem, 400)
    const client = await helpers.lookupClient(authRequest.clientId)
    if (!client) return errorResponse('Unknown OAuth client.', 400)
    return htmlResponse(renderAuthorizePage({
        clientName: client.clientName?.trim() || client.clientId,
        redirectHost: redirectHostForDisplay(authRequest.redirectUri),
        encodedRequest: encodeAuthRequest(authRequest),
    }))
}

async function handleAuthorizePost(request, env, helpers) {
    const authToken = env.AUTH_TOKEN
    if (!isUsableAuthToken(authToken)) return misconfiguredResponse()
    let form
    try {
        form = await request.formData()
    } catch {
        return errorResponse('Invalid form submission.', 400)
    }
    const encodedRequest = form.get('oauth_request')
    const authRequest = typeof encodedRequest === 'string' ? decodeAuthRequest(encodedRequest) : null
    if (!authRequest) return errorResponse('Invalid authorization request.', 400)
    const problem = authRequestProblem(authRequest, parseAllowedRedirectHosts(env.ALLOWED_REDIRECT_HOSTS))
    if (problem) return errorResponse(problem, 400)

    const client = await helpers.lookupClient(authRequest.clientId)
    if (!client) return errorResponse('Unknown OAuth client.', 400)
    const rerender = (error, status) => htmlResponse(renderAuthorizePage({
        clientName: client.clientName?.trim() || client.clientId,
        redirectHost: redirectHostForDisplay(authRequest.redirectUri),
        encodedRequest,
        error,
    }), status)

    const submitted = form.get('token')
    const token = typeof submitted === 'string' ? submitted.trim() : ''
    if (!token) return rerender('Enter the access token.', 400)
    if (!(await tokensMatch(token, authToken))) return rerender('Incorrect token.', 401)

    try {
        const { redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId: GRANT_USER_ID,
            metadata: {},
            scope: authRequest.scope,
            props: {},
        })
        return new Response(null, {
            status: 302,
            headers: { Location: redirectTo, 'Cache-Control': 'no-store' },
        })
    } catch {
        return errorResponse('Authorization could not be completed. Please try again.', 502)
    }
}

/**
 * `resourceUrl` is this deployment's bare origin — what claude.ai's client
 * sends as the `resource` parameter — and binds every issued token to this
 * Worker, so a token minted by another Worker sharing the KV namespace is
 * rejected here. `handleMcp` only ever sees requests carrying a valid token.
 */
export function createOAuthProvider({ resourceUrl, mcpPath, handleMcp }) {
    return new OAuthProvider({
        apiRoute: mcpPath,
        apiHandler: { fetch: handleMcp },
        defaultHandler: {
            async fetch(request, env) {
                const helpers = env.OAUTH_PROVIDER
                if (new URL(request.url).pathname !== AUTHORIZE_PATH) {
                    return new Response('Not found', { status: 404 })
                }
                if (request.method === 'GET') return handleAuthorizeGet(request, env, helpers)
                if (request.method === 'POST') return handleAuthorizePost(request, env, helpers)
                return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
            },
        },
        authorizeEndpoint: AUTHORIZE_PATH,
        tokenEndpoint: TOKEN_PATH,
        clientRegistrationEndpoint: REGISTER_PATH,
        scopesSupported: ['mcp'],
        accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
        clientIdMetadataDocumentEnabled: true,
        allowPlainPKCE: false,
        resourceMetadata: {
            resource_name: 'Bark MCP Server',
            resource: resourceUrl,
        },
        // claude.ai's CIMD client metadata document advertises
        // urn:ietf:params:oauth:grant-type:jwt-bearer among its supported grant
        // types, and the provider's CIMD validation rejects any client that
        // advertises a grant type the server doesn't. This stub advertises it
        // without ever honouring it (trustedIssuers never trusts an issuer).
        // Same gotcha, same fix, as marktplaats-mcp's and hevy-mcp's OAuth
        // wiring in this repo.
        enterpriseManagedAuthorization: {
            trustedIssuers: async () => null,
            mapClaims: async () => {
                throw new Error('unreachable: trustedIssuers never trusts an issuer')
            },
        },
    })
}
