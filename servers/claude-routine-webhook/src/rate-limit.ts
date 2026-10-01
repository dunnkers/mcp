/// <reference types="@cloudflare/workers-types" />

// Checked first thing in the fetch handler, before the upstream call, so a
// flood of requests gets a cheap 429 instead of each one hitting the Anthropic
// API (and, with a valid token, starting a routine run). The actual limit
// (30 requests/60s) is configured on the binding itself, in wrangler.jsonc's
// `ratelimits[].simple`, not here.
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
