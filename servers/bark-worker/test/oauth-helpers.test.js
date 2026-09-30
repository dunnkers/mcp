import assert from 'node:assert/strict'
import test from 'node:test'

import {
    authRequestProblem,
    decodeAuthRequest,
    DEFAULT_ALLOWED_REDIRECT_HOSTS,
    encodeAuthRequest,
    isAllowedRedirectUri,
    isMcpPath,
    isOAuthPath,
    isUsableAuthToken,
    mcpPathFor,
    parseAllowedRedirectHosts,
    renderAuthorizePage,
    tokensMatch,
} from '../src/oauth-helpers.js'

const SAMPLE_AUTH_REQUEST = {
    responseType: 'code',
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    scope: ['mcp'],
    state: 'xyz',
    codeChallenge: 'abc123',
    codeChallengeMethod: 'S256',
}

test('routes /mcp and /mcp/<device_key> to OAuth, but not Bark device keys starting with "mcp"', () => {
    assert.equal(mcpPathFor('/'), '/mcp')
    assert.equal(mcpPathFor(undefined), '/mcp')
    assert.equal(mcpPathFor('/bark'), '/bark/mcp')
    assert.equal(mcpPathFor('/bark/'), '/bark/mcp')

    assert.equal(isMcpPath('/mcp', '/mcp'), true)
    assert.equal(isMcpPath('/mcp/device-key', '/mcp'), true)
    assert.equal(isMcpPath('/mcpDeviceKey/hello', '/mcp'), false)
    assert.equal(isMcpPath('/device-key/mcp', '/mcp'), false)
})

test('routes discovery and OAuth endpoints, but not Bark\'s own /register', () => {
    assert.equal(isOAuthPath('/.well-known/oauth-authorization-server'), true)
    assert.equal(isOAuthPath('/.well-known/oauth-protected-resource/mcp'), true)
    assert.equal(isOAuthPath('/oauth/authorize'), true)
    assert.equal(isOAuthPath('/oauth/token'), true)
    assert.equal(isOAuthPath('/oauth/register'), true)
    assert.equal(isOAuthPath('/register'), false)
    assert.equal(isOAuthPath('/push'), false)
})

test('round-trips an auth request and rejects garbage', () => {
    const encoded = encodeAuthRequest(SAMPLE_AUTH_REQUEST)
    assert.doesNotMatch(encoded, /[+/=]/)
    assert.deepEqual(decodeAuthRequest(encoded), SAMPLE_AUTH_REQUEST)
    assert.equal(decodeAuthRequest('not-valid-base64!!!'), null)
    assert.equal(decodeAuthRequest(btoa('"a string"')), null)
})

test('tokensMatch compares exactly', async () => {
    assert.equal(await tokensMatch('secret-123', 'secret-123'), true)
    assert.equal(await tokensMatch('secret-123', 'secret-1234'), false)
})

test('redirect allowlist admits claude.ai and loopback only', () => {
    const hosts = DEFAULT_ALLOWED_REDIRECT_HOSTS
    assert.deepEqual(parseAllowedRedirectHosts(undefined), hosts)
    assert.deepEqual(parseAllowedRedirectHosts(' Claude.ai, chatgpt.com '), ['claude.ai', 'chatgpt.com'])

    assert.equal(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', hosts), true)
    assert.equal(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback', hosts), true)
    assert.equal(isAllowedRedirectUri('http://localhost:33418/callback', hosts), true)
    assert.equal(isAllowedRedirectUri('http://127.0.0.1:8080/cb', hosts), true)
    assert.equal(isAllowedRedirectUri('http://[::1]:8080/cb', hosts), true)

    assert.equal(isAllowedRedirectUri('https://evil.example/cb', hosts), false)
    assert.equal(isAllowedRedirectUri('https://claude.ai.evil.example/cb', hosts), false)
    assert.equal(isAllowedRedirectUri('http://claude.ai/cb', hosts), false)
    assert.equal(isAllowedRedirectUri('https://user@claude.ai/cb', hosts), false)
    assert.equal(isAllowedRedirectUri('javascript:alert(1)', hosts), false)
})

test('authRequestProblem requires the code flow, S256 PKCE and an allowed redirect', () => {
    const hosts = DEFAULT_ALLOWED_REDIRECT_HOSTS
    assert.equal(authRequestProblem(SAMPLE_AUTH_REQUEST, hosts), null)
    assert.match(authRequestProblem({ ...SAMPLE_AUTH_REQUEST, codeChallenge: undefined }, hosts), /PKCE/)
    assert.match(authRequestProblem({ ...SAMPLE_AUTH_REQUEST, codeChallengeMethod: 'plain' }, hosts), /PKCE/)
    assert.match(authRequestProblem({ ...SAMPLE_AUTH_REQUEST, responseType: 'token' }, hosts), /authorization code/)
    assert.match(authRequestProblem({ ...SAMPLE_AUTH_REQUEST, redirectUri: 'https://evil.example/cb' }, hosts), /evil\.example/)
})

test('AUTH_TOKEN must be at least 32 characters', () => {
    assert.equal(isUsableAuthToken(undefined), false)
    assert.equal(isUsableAuthToken('hunter2'), false)
    assert.equal(isUsableAuthToken('a'.repeat(32)), true)
})

test('consent page escapes untrusted values and shows the redirect host', () => {
    const html = renderAuthorizePage({
        clientName: '<script>alert("x")</script>',
        redirectHost: 'claude.ai',
        encodedRequest: 'abc"123',
    })
    assert.doesNotMatch(html, /<script>alert/)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /value="abc&quot;123"/)
    assert.match(html, /<strong>claude\.ai<\/strong>/)
    assert.match(html, /action="\/oauth\/authorize"/)
    assert.doesNotMatch(html, /color:#b91c1c/)
    assert.match(renderAuthorizePage({ clientName: 'c', redirectHost: 'h', encodedRequest: 'x', error: 'Nope' }), /Nope/)
})
