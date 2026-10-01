import { discoveryDocument, getAccessToken, issuerFor, publicJwks } from "./auth.js";
import type { Env } from "./env.js";
import { summarize } from "./gemini.js";
import { InputError, readInput } from "./input.js";

// POST anything (a File body from an Apple Shortcut, JSON, text, multipart,
// audio/video/image/PDF) and get back Gemini's faithful text rendering of it.
// Google Cloud access uses workload identity federation: this Worker is its
// own OIDC issuer (see auth.ts), so no Google credential is stored.
const MIN_AUTH_TOKEN_LENGTH = 32;
const RETRY_AFTER_SECONDS = 60;

const text = (status: number, body: string, headers: HeadersInit = {}) =>
	new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
	const header = request.headers.get("authorization") ?? "";
	const supplied = header.replace(/^Bearer\s+/i, "");
	// Hash both sides so the comparison is constant-length and constant-time.
	const [a, b] = await Promise.all(
		[supplied, env.AUTH_TOKEN].map(async (value) =>
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
		),
	);
	let diff = 0;
	for (let i = 0; i < a!.length; i++) diff |= a![i]! ^ b![i]!;
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		// Public: Google STS reads these to verify the Worker's OIDC tokens.
		if (request.method === "GET" && pathname === "/.well-known/openid-configuration") {
			return json(200, discoveryDocument(issuerFor(request, env)));
		}
		if (request.method === "GET" && pathname === "/.well-known/jwks.json") {
			try {
				return json(200, publicJwks(env));
			} catch (error) {
				return json(500, { error: (error as Error).message });
			}
		}

		if (request.method !== "POST" && request.method !== "PUT") {
			return new Response(null, { status: 405, headers: { allow: "POST, PUT" } });
		}

		// Rate limit first so floods get a cheap 429 before any hashing or upstream work.
		const { success } = await env.RATE_LIMITER.limit({
			key: request.headers.get("cf-connecting-ip") ?? "unknown",
		});
		if (!success) return new Response(null, { status: 429, headers: { "Retry-After": String(RETRY_AFTER_SECONDS) } });

		if ((env.AUTH_TOKEN ?? "").length < MIN_AUTH_TOKEN_LENGTH) {
			return text(500, `Server misconfigured: AUTH_TOKEN must be set to at least ${MIN_AUTH_TOKEN_LENGTH} characters.`);
		}
		if (!(await isAuthorized(request, env))) {
			return text(401, "Missing or invalid Authorization header (Bearer <token>).", {
				"www-authenticate": "Bearer",
			});
		}

		try {
			const input = await readInput(request);
			const accessToken = await getAccessToken(env, issuerFor(request, env));
			return text(200, await summarize(env, accessToken, input));
		} catch (error) {
			if (error instanceof InputError) return text(error.status, error.message);
			console.error(error);
			return text(502, `Upstream error: ${(error as Error).message}`);
		}
	},
} satisfies ExportedHandler<Env>;
