/// <reference types="@cloudflare/workers-types" />

// Checked first thing in the fetch handler, before OAuth/routing/the SSE
// bridge to crawl4ai's Cloud Run backend, so a flood of requests gets a
// cheap 429 instead of paying for a KV lookup (OAuth token validation) or an
// upstream request on every hit. This is volumetric abuse protection,
// independent of the OAuth gate in oauth.ts — a client with a *valid* token
// could still hammer the Worker (and, through it, the Cloud Run backend). The
// actual limit (60 requests/60s) is configured on the binding itself, in
// wrangler.jsonc's `unsafe.bindings[].simple`, not here.
const RETRY_AFTER_SECONDS = 60;

export interface RateLimitedEnv {
	RATE_LIMITER: RateLimit;
}

export async function checkRateLimit(
	request: Request,
	env: RateLimitedEnv,
): Promise<Response | null> {
	// cf-connecting-ip is set by Cloudflare's edge and can't be spoofed by the
	// client; falls back to a shared bucket if it's ever absent (e.g. local dev).
	const key = request.headers.get("cf-connecting-ip") ?? "unknown";
	const { success } = await env.RATE_LIMITER.limit({ key });
	if (success) return null;
	return new Response(null, {
		status: 429,
		headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
	});
}
