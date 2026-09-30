/// <reference types="@cloudflare/workers-types" />

import {
	type AuthRequest,
	OAuthProvider,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
	AUTHORIZE_PATH,
	authRequestProblem,
	decodeAuthRequest,
	encodeAuthRequest,
	errorResponse,
	htmlResponse,
	isUsableAuthToken,
	MCP_PATH,
	MIN_AUTH_TOKEN_LENGTH,
	parseAllowedRedirectHosts,
	redirectHostForDisplay,
	renderAuthorizePage,
	tokensMatch,
} from "./oauth-helpers.js";

const TOKEN_PATH = "/token";
const REGISTER_PATH = "/register";

// One-hour access tokens would make claude.ai refresh several times a day,
// and every refresh writes to KV. This is a single-user personal deployment,
// so a long-lived session is fine and keeps well under KV's free-plan write
// quota (same reasoning as marktplaats-mcp's and
// hevy-mcp's OAuth wiring in this repo, which run the same library against
// the same Cloudflare account).
const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// The single user every grant is issued to. Must be unique per Worker: the
// OAuth KV namespace is shared with this repo's other Workers, grants live
// under `grant:<userId>:`, and completeAuthorization revokes the user's
// existing grants for the same client — and claude.ai uses one client id for
// every connector. A shared userId would make connecting one server silently
// disconnect the others.
const GRANT_USER_ID = "vinted-mcp-owner";

export interface Env {
	OAUTH_KV: KVNamespace;
	// Gates the /authorize consent form. This Worker's vendored client bootstraps
	// its own Vinted session per request (see mcp-handler.ts / ../README.md); this
	// token exists purely to control who can mint an OAuth grant against this
	// Worker. Set
	// via `wrangler secret put AUTH_TOKEN`; must be at least
	// MIN_AUTH_TOKEN_LENGTH characters or /authorize refuses to run.
	AUTH_TOKEN?: string;
	// Optional comma-separated override of the hosts /authorize may redirect
	// back to (loopback is always allowed). See DEFAULT_ALLOWED_REDIRECT_HOSTS.
	ALLOWED_REDIRECT_HOSTS?: string;
	// Volumetric abuse protection, checked in index.ts before this provider
	// ever sees the request. See rate-limit.ts.
	RATE_LIMITER: RateLimit;
}

interface OAuthProviderEnv extends Env {
	OAUTH_PROVIDER: OAuthHelpers;
}

function misconfiguredResponse(): Response {
	console.error({
		event: "oauth.misconfigured",
		reason: `AUTH_TOKEN is unset or shorter than ${MIN_AUTH_TOKEN_LENGTH} characters`,
	});
	return errorResponse("This server's authorization is not configured.", 503);
}

async function handleAuthorizeGet(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
): Promise<Response> {
	if (!isUsableAuthToken(env.AUTH_TOKEN)) return misconfiguredResponse();
	let authRequest: AuthRequest;
	try {
		authRequest = await helpers.parseAuthRequest(request);
	} catch {
		return errorResponse("Invalid authorization request.", 400);
	}
	const problem = authRequestProblem(
		authRequest,
		parseAllowedRedirectHosts(env.ALLOWED_REDIRECT_HOSTS),
	);
	if (problem) return errorResponse(problem, 400);
	const client = await helpers.lookupClient(authRequest.clientId);
	if (!client) return errorResponse("Unknown OAuth client.", 400);
	return htmlResponse(
		renderAuthorizePage({
			clientName: client.clientName?.trim() || client.clientId,
			redirectHost: redirectHostForDisplay(authRequest.redirectUri),
			encodedRequest: encodeAuthRequest(authRequest),
		}),
	);
}

async function handleAuthorizePost(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
): Promise<Response> {
	const authToken = env.AUTH_TOKEN;
	if (!isUsableAuthToken(authToken)) return misconfiguredResponse();
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return errorResponse("Invalid form submission.", 400);
	}
	const encodedRequest = form.get("oauth_request");
	const authRequest =
		typeof encodedRequest === "string" ? decodeAuthRequest(encodedRequest) : null;
	if (!authRequest) return errorResponse("Invalid authorization request.", 400);
	const problem = authRequestProblem(
		authRequest,
		parseAllowedRedirectHosts(env.ALLOWED_REDIRECT_HOSTS),
	);
	if (problem) return errorResponse(problem, 400);

	const client = await helpers.lookupClient(authRequest.clientId);
	if (!client) return errorResponse("Unknown OAuth client.", 400);
	const clientName = client.clientName?.trim() || client.clientId;
	const rerender = (error: string, status: number): Response =>
		htmlResponse(
			renderAuthorizePage({
				clientName,
				redirectHost: redirectHostForDisplay(authRequest.redirectUri),
				encodedRequest: encodedRequest as string,
				error,
			}),
			status,
		);

	const submitted = form.get("token");
	const token = typeof submitted === "string" ? submitted.trim() : "";
	if (!token) return rerender("Enter the access token.", 400);
	if (!(await tokensMatch(token, authToken))) {
		return rerender("Incorrect token.", 401);
	}

	try {
		const { redirectTo } = await helpers.completeAuthorization({
			request: authRequest,
			userId: GRANT_USER_ID,
			metadata: {},
			scope: authRequest.scope,
			props: {},
		});
		return new Response(null, {
			status: 302,
			headers: { Location: redirectTo, "Cache-Control": "no-store" },
		});
	} catch {
		return errorResponse("Authorization could not be completed. Please try again.", 502);
	}
}

export function createOAuthProvider(
	resourceUrl: string,
	handleMcpRequest: (request: Request) => Promise<Response>,
) {
	return new OAuthProvider({
		apiRoute: MCP_PATH,
		apiHandler: {
			fetch: (request: Request) => {
				const pathname = new URL(request.url).pathname;
				if (request.method === "POST" && pathname === MCP_PATH) {
					return handleMcpRequest(request);
				}
				return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
			},
		},
		defaultHandler: {
			// Declared as plain `Env` to match what the library's own
			// ExportedHandler type expects here; at runtime the provider
			// always injects OAUTH_PROVIDER before invoking this handler,
			// so the narrower cast below is safe.
			fetch: async (request: Request, env: Env) => {
				const helpers = (env as OAuthProviderEnv).OAUTH_PROVIDER;
				const url = new URL(request.url);
				if (url.pathname === AUTHORIZE_PATH) {
					if (request.method === "GET") return handleAuthorizeGet(request, env, helpers);
					if (request.method === "POST") return handleAuthorizePost(request, env, helpers);
					return new Response("Method not allowed", {
						status: 405,
						headers: { Allow: "GET, POST" },
					});
				}
				if (url.pathname === "/" || url.pathname === "") {
					return Response.json({
						name: "vinted-mcp",
						description:
							"MCP server for searching and comparing Vinted marketplace listings across 19 countries.",
						mcp_endpoint: MCP_PATH,
					});
				}
				return new Response("Not found", { status: 404 });
			},
		},
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: TOKEN_PATH,
		clientRegistrationEndpoint: REGISTER_PATH,
		scopesSupported: ["mcp"],
		accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
		refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
		clientIdMetadataDocumentEnabled: true,
		allowPlainPKCE: false,
		resourceMetadata: {
			resource_name: "vinted-mcp Server",
			resource: resourceUrl,
		},
		// claude.ai's CIMD client metadata document advertises
		// urn:ietf:params:oauth:grant-type:jwt-bearer among its supported grant
		// types (for enterprise-managed authorization on claude.ai's side), even
		// though this server's connector flow only ever exercises
		// authorization_code. The provider's CIMD validation rejects any client
		// that advertises a grant type the server doesn't also advertise, so
		// this stub must be present for claude.ai's custom connector to
		// complete authorization at all — trustedIssuers never trusts an
		// issuer, since this server has no real enterprise SSO to offer.
		// (Same gotcha, same fix, as marktplaats-mcp's and
		// hevy-mcp's OAuth wiring in this repo.)
		enterpriseManagedAuthorization: {
			trustedIssuers: async () => null,
			mapClaims: async () => {
				throw new Error(
					"unreachable: trustedIssuers never trusts an issuer, so no jwt-bearer grant should reach claim mapping",
				);
			},
		},
	});
}
