/// <reference types="@cloudflare/workers-types" />

import {
	type AuthRequest,
	OAuthProvider,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
	AUTHORIZE_PATH,
	decodeAuthRequest,
	encodeAuthRequest,
	errorResponse,
	htmlResponse,
	renderAuthorizePage,
	tokensMatch,
} from "./oauth-helpers.js";

export const MCP_PATH = "/mcp";
const TOKEN_PATH = "/token";
const REGISTER_PATH = "/register";

// One-hour access tokens would make claude.ai refresh several times a day,
// and every refresh writes to KV. This is a single-user personal deployment,
// so a long-lived session is fine and keeps well under KV's free-plan write
// quota (mirrors the reasoning in hevy-mcp's worker-oauth.ts, which runs the
// same library against the same Cloudflare account).
const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Env {
	OAUTH_KV: KVNamespace;
	CRAWL4AI_API_TOKEN: string;
	UPSTREAM_ORIGIN: string;
}

interface OAuthProviderEnv extends Env {
	OAUTH_PROVIDER: OAuthHelpers;
}

async function handleAuthorizeGet(request: Request, helpers: OAuthHelpers): Promise<Response> {
	let authRequest: AuthRequest;
	try {
		authRequest = await helpers.parseAuthRequest(request);
	} catch {
		return errorResponse("Invalid authorization request.", 400);
	}
	const client = await helpers.lookupClient(authRequest.clientId);
	if (!client) return errorResponse("Unknown OAuth client.", 400);
	return htmlResponse(
		renderAuthorizePage({
			clientName: client.clientName?.trim() || client.clientId,
			encodedRequest: encodeAuthRequest(authRequest),
		}),
	);
}

async function handleAuthorizePost(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
): Promise<Response> {
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

	const client = await helpers.lookupClient(authRequest.clientId);
	if (!client) return errorResponse("Unknown OAuth client.", 400);
	const clientName = client.clientName?.trim() || client.clientId;
	const rerender = (error: string, status: number): Response =>
		htmlResponse(
			renderAuthorizePage({ clientName, encodedRequest: encodedRequest as string, error }),
			status,
		);

	const submitted = form.get("token");
	const token = typeof submitted === "string" ? submitted.trim() : "";
	if (!token) return rerender("Enter the crawl4ai API token.", 400);
	if (!(await tokensMatch(token, env.CRAWL4AI_API_TOKEN))) {
		return rerender("Incorrect token.", 401);
	}

	try {
		const { redirectTo } = await helpers.completeAuthorization({
			request: authRequest,
			userId: "jeroen",
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

/**
 * Forwards an already-OAuth-authenticated request to the real crawl4ai
 * service, swapping in the real `CRAWL4AI_API_TOKEN` as the Bearer header.
 * claude.ai never sees this token — it only ever holds the OAuth access
 * token this provider issued.
 */
async function proxyToUpstream(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const upstreamUrl = new URL(url.pathname + url.search, env.UPSTREAM_ORIGIN);

	const upstreamHeaders = new Headers(request.headers);
	upstreamHeaders.delete("host");
	upstreamHeaders.set("authorization", `Bearer ${env.CRAWL4AI_API_TOKEN}`);

	return fetch(upstreamUrl.toString(), {
		method: request.method,
		headers: upstreamHeaders,
		body: request.body,
		// @ts-expect-error Cloudflare-specific: required to stream a request body through.
		duplex: request.body ? "half" : undefined,
	});
}

export function createOAuthProvider(resourceUrl: string) {
	return new OAuthProvider({
		apiRoute: MCP_PATH,
		apiHandler: {
			fetch: (request: Request, env: Env) => proxyToUpstream(request, env),
		},
		defaultHandler: {
			// Declared as plain `Env` to match what the library's own
			// ExportedHandler type expects here; at runtime the provider
			// always injects OAUTH_PROVIDER before invoking this handler,
			// so the narrower cast below is safe.
			fetch: async (request: Request, env: Env) => {
				const helpers = (env as OAuthProviderEnv).OAUTH_PROVIDER;
				const url = new URL(request.url);
				if (url.pathname !== AUTHORIZE_PATH) {
					return new Response("Not found", { status: 404 });
				}
				if (request.method === "GET") {
					return handleAuthorizeGet(request, helpers);
				}
				if (request.method === "POST") {
					return handleAuthorizePost(request, env, helpers);
				}
				return new Response("Method not allowed", {
					status: 405,
					headers: { Allow: "GET, POST" },
				});
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
			resource_name: "crawl4ai MCP Server",
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
		// (Same gotcha, same fix, as hevy-mcp's worker-oauth.ts in this repo.)
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
