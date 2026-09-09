/**
 * Auth-shape translation proxy for crawl4ai-mcp.
 *
 * claude.ai's SSE custom-connector UI accepts a manually configured
 * `Authorization` header, but never actually sends it on the wire (verified
 * via Cloud Run request logs while debugging a 401 loop). crawl4ai itself
 * only accepts the token as a `Bearer` header, not a query param. This
 * worker bridges the two: it takes the token from a `?token=` query param
 * (which claude.ai *does* preserve, since it's just part of the connector
 * URL) and forwards it upstream as `Authorization: Bearer <token>`.
 *
 * crawl4ai's SSE transport is two-step: opening `/mcp/sse` returns a
 * `data: /mcp/messages/?session_id=...` event naming a relative follow-up
 * URL, and clients POST subsequent JSON-RPC messages there. That follow-up
 * request needs its own auth. Since this worker is stateless (no KV/Durable
 * Object) and never stores the token, the follow-up URL is rewritten
 * on the fly, in the streamed response body, to carry the token forward as
 * a query param too — so it round-trips through the client without the
 * worker having to remember anything.
 */

const UPSTREAM_ORIGIN = "https://crawl4ai-mcp-500845880919.europe-west4.run.app";

function unauthorized(message: string): Response {
	return Response.json({ error: message }, { status: 401 });
}

/** Rewrites `data: /mcp/messages/?session_id=X` lines to append `&token=`. */
function rewriteEndpointEvent(token: string) {
	let buffered = "";
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffered += decoder.decode(chunk, { stream: true });
			const lines = buffered.split("\n");
			// Last element may be a partial line; hold it back until more data arrives.
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${rewriteLine(line, token)}\n`));
			}
		},
		flush(controller) {
			if (buffered.length > 0) {
				controller.enqueue(encoder.encode(rewriteLine(buffered, token)));
			}
		},
	});
}

function rewriteLine(line: string, token: string): string {
	const prefix = "data: /mcp/messages/";
	if (!line.startsWith(prefix)) return line;
	const path = line.slice("data: ".length);
	const url = new URL(path, "https://placeholder.invalid");
	url.searchParams.set("token", token);
	return `data: ${url.pathname}${url.search}`;
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const token = url.searchParams.get("token");
		if (!token) {
			return unauthorized("Missing ?token= query param.");
		}

		const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
		upstreamUrl.searchParams.delete("token");

		const upstreamHeaders = new Headers(request.headers);
		upstreamHeaders.delete("host");
		upstreamHeaders.set("authorization", `Bearer ${token}`);

		const upstreamResponse = await fetch(upstreamUrl.toString(), {
			method: request.method,
			headers: upstreamHeaders,
			body: request.body,
			// @ts-expect-error Cloudflare-specific: required to stream a request body through.
			duplex: request.body ? "half" : undefined,
		});

		const contentType = upstreamResponse.headers.get("content-type") ?? "";
		const isEventStream = contentType.includes("text/event-stream");
		const body =
			isEventStream && upstreamResponse.body
				? upstreamResponse.body.pipeThrough(rewriteEndpointEvent(token))
				: upstreamResponse.body;

		return new Response(body, {
			status: upstreamResponse.status,
			headers: upstreamResponse.headers,
		});
	},
} satisfies ExportedHandler;
