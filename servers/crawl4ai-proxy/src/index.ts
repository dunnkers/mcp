/// <reference types="@cloudflare/workers-types" />

import { createOAuthProvider, type Env } from "./oauth.js";
import { checkRateLimit } from "./rate-limit.js";

/**
 * Lazily builds (and memoizes per canonical origin) the OAuth provider.
 * Construction needs the deployment's own origin for `resourceMetadata.resource`
 * — the bare origin, matching what claude.ai's client actually sends as the
 * `resource` parameter — which is only known once a request arrives, since
 * Workers don't expose the request origin at module-eval time.
 */
function createProviderGetter() {
	let cached: { origin: string; provider: ReturnType<typeof createOAuthProvider> } | null = null;
	return function getProvider(request: Request) {
		const origin = new URL(request.url).origin;
		if (cached === null || cached.origin !== origin) {
			cached = { origin, provider: createOAuthProvider(origin) };
		}
		return cached.provider;
	};
}

const getProvider = createProviderGetter();

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Checked before anything else — no OAuth/KV lookup, no SSE bridge to
		// Cloud Run — so a flood is denied as cheaply as possible.
		const limited = await checkRateLimit(request, env);
		if (limited) return limited;
		return getProvider(request).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
