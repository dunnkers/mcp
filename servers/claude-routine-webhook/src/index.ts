import { checkRateLimit, type RateLimitedEnv } from "./rate-limit.js";

// Talat (and similar apps) POST their own JSON to a webhook, while a Claude
// Code routine's fire endpoint only accepts `{"text": "..."}`. This Worker
// mirrors the fire endpoint's path, wraps whatever body arrives into `text`,
// and forwards it — along with the caller's Authorization header — to
// api.anthropic.com. Point the webhook at
// https://<worker>/v1/claude_code/routines/<trigger id>/fire instead of
// https://api.anthropic.com/v1/claude_code/routines/<trigger id>/fire.
export const UPSTREAM_ORIGIN = "https://api.anthropic.com";
const FIRE_PATH = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]+)\/fire\/?$/;

// Sent when the caller doesn't set its own (Talat lets you add them as
// custom headers, but they shouldn't be required).
const DEFAULT_HEADERS = {
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "experimental-cc-routine-2026-04-01",
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: RateLimitedEnv): Promise<Response> {
		const match = FIRE_PATH.exec(new URL(request.url).pathname);
		if (!match) {
			return json(404, {
				error: "Not found. POST to /v1/claude_code/routines/<trigger id>/fire.",
			});
		}
		if (request.method !== "POST" && request.method !== "PUT") {
			return new Response(null, { status: 405, headers: { allow: "POST, PUT" } });
		}
		const authorization = request.headers.get("authorization");
		if (!authorization) {
			return json(401, { error: "Missing Authorization header (Bearer <routine token>)." });
		}

		const limited = await checkRateLimit(request, env);
		if (limited) return limited;

		// The raw body, byte-for-byte as sent (JSON or otherwise), becomes the
		// extra turn appended to the routine's session. An empty body fires the
		// routine with just its configured prompt.
		const text = await request.text();
		const headers = new Headers({ authorization, "content-type": "application/json" });
		for (const [name, fallback] of Object.entries(DEFAULT_HEADERS)) {
			headers.set(name, request.headers.get(name) ?? fallback);
		}

		const upstream = await fetch(`${UPSTREAM_ORIGIN}${match[0].replace(/\/$/, "")}`, {
			method: "POST",
			headers,
			body: JSON.stringify(text.trim() === "" ? {} : { text }),
		});
		// Relay Anthropic's response so the webhook sender sees real failures
		// (bad token, oversized text, …) rather than a blanket 200.
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
		});
	},
} satisfies ExportedHandler<RateLimitedEnv>;
