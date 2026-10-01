// Pure logic used by oauth.ts, split out so tests can import it without
// pulling in @cloudflare/workers-oauth-provider's runtime (which requires
// the `cloudflare:workers` module and can't load under plain Node/vitest).
// Mirrors servers/marktplaats-mcp/src/oauth-helpers.ts in this repo.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export const AUTHORIZE_PATH = "/authorize";
export const MCP_PATH = "/mcp";

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export const HTML_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	// No form-action directive: it would apply to the 302 redirect back to the
	// OAuth client's redirect_uri (e.g. claude.ai) after a successful submit.
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

export function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: HTML_HEADERS });
}

export function encodeAuthRequest(authRequest: AuthRequest): string {
	const bytes = new TextEncoder().encode(JSON.stringify(authRequest));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeAuthRequest(encoded: string): AuthRequest | null {
	try {
		const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
		const binary = atob(base64);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes)) as AuthRequest;
	} catch {
		return null;
	}
}

export function renderAuthorizePage(options: {
	clientName: string;
	redirectHost: string;
	encodedRequest: string;
	error?: string;
}): string {
	const clientName = escapeHtml(options.clientName);
	const redirectHost = escapeHtml(options.redirectHost);
	const encodedRequest = escapeHtml(options.encodedRequest);
	const errorBanner = options.error
		? `<p style="color:#b91c1c">${escapeHtml(options.error)}</p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${clientName} to vinted-mcp</title>
<style>
	:root { color-scheme: light dark; }
	body {
		font-family: system-ui, -apple-system, sans-serif;
		background: #f4f4f5; color: #18181b;
		display: flex; justify-content: center;
		margin: 0; padding: 2rem 1rem; min-height: 100vh; box-sizing: border-box;
	}
	main {
		background: #fff; border: 1px solid #e4e4e7; border-radius: 12px;
		padding: 2rem; max-width: 26rem; width: 100%; height: fit-content; box-sizing: border-box;
	}
	h1 { font-size: 1.25rem; margin: 0 0 1rem; }
	p { line-height: 1.5; margin: 0 0 1rem; }
	label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
	input[type="password"] {
		width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.6rem 0.75rem;
		margin-bottom: 1rem; border: 1px solid #d4d4d8; border-radius: 8px; background: inherit; color: inherit;
	}
	button {
		width: 100%; font-size: 1rem; font-weight: 600; padding: 0.7rem;
		border: none; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer;
	}
	@media (prefers-color-scheme: dark) {
		body { background: #18181b; color: #fafafa; }
		main { background: #27272a; border-color: #3f3f46; }
		input[type="password"] { border-color: #52525b; }
	}
</style>
</head>
<body>
<main>
<h1>Connect to vinted-mcp</h1>
<p><strong>${clientName}</strong> is requesting access to the vinted-mcp server.
After connecting you'll be sent back to <strong>${redirectHost}</strong>.</p>
${errorBanner}
<form method="post" action="${AUTHORIZE_PATH}">
<input type="hidden" name="oauth_request" value="${encodedRequest}">
<label for="token">Access token</label>
<input type="password" id="token" name="token" autocomplete="off" required>
<button type="submit">Connect</button>
</form>
</main>
</body>
</html>`;
}

export function errorResponse(message: string, status: number): Response {
	return htmlResponse(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${escapeHtml(message)}</p></body></html>`,
		status,
	);
}

/** Constant-time comparison so a mistyped token can't be brute-forced via response timing. */
export async function tokensMatch(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	return diff === 0;
}

// Redirect hosts an authorization may be sent back to. claude.ai's custom
// connectors call back to https://claude.ai/api/mcp/auth_callback
// (claude.com is the same product's other domain). Loopback redirects —
// used by desktop/CLI MCP clients such as Claude Code — are always allowed,
// since they can only ever deliver the code to the machine that started the
// flow. Anything else is refused, so a client registered through the open
// /register endpoint (or a CIMD URL) with an attacker-controlled redirect_uri
// can't be used to phish a grant out of whoever knows AUTH_TOKEN. Override
// with a comma-separated ALLOWED_REDIRECT_HOSTS var.
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// AUTH_TOKEN is the only thing standing between the public internet and a
// freshly minted OAuth grant, so refuse to run the consent page at all with a
// guessable one. 32 characters matches `openssl rand -hex 16`.
export const MIN_AUTH_TOKEN_LENGTH = 32;

export function parseAllowedRedirectHosts(value: string | undefined): string[] {
	const hosts = (value ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_REDIRECT_HOSTS;
}

export function isAllowedRedirectUri(redirectUri: string, allowedHosts: string[]): boolean {
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch {
		return false;
	}
	if (url.username || url.password) return false;
	if (LOOPBACK_HOSTNAMES.has(url.hostname)) {
		return url.protocol === "http:" || url.protocol === "https:";
	}
	return url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase());
}

/** Host shown on the consent page, so the user can see where the grant goes. */
export function redirectHostForDisplay(redirectUri: string): string {
	try {
		return new URL(redirectUri).host;
	} catch {
		return redirectUri;
	}
}

/**
 * OAuth 2.1 requires PKCE for public clients; the library only checks it when
 * a challenge is present. Require S256 on every request, like hevy-mcp does.
 */
export function hasS256Pkce(authRequest: AuthRequest): boolean {
	return Boolean(authRequest.codeChallenge) && authRequest.codeChallengeMethod === "S256";
}

export function isUsableAuthToken(token: string | undefined): token is string {
	return typeof token === "string" && token.trim().length >= MIN_AUTH_TOKEN_LENGTH;
}

/**
 * Checks shared by GET and POST /authorize. The POST re-runs them on the
 * request decoded from the form's hidden field, since that's client-supplied.
 * Returns an error message, or null when the request may proceed.
 */
export function authRequestProblem(
	authRequest: AuthRequest,
	allowedHosts: string[],
): string | null {
	if (authRequest.responseType !== "code") {
		return "Only the authorization code flow is supported.";
	}
	if (!hasS256Pkce(authRequest)) {
		return "This server requires PKCE with an S256 code challenge.";
	}
	if (!isAllowedRedirectUri(authRequest.redirectUri, allowedHosts)) {
		return `Redirects to ${redirectHostForDisplay(authRequest.redirectUri)} are not allowed by this server.`;
	}
	return null;
}
