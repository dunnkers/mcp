// Pure logic used by oauth.ts, split out so tests can import it without
// pulling in @cloudflare/workers-oauth-provider's runtime (which requires
// the `cloudflare:workers` module and can't load under plain Node/vitest).
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export const AUTHORIZE_PATH = "/authorize";
export const MCP_PATH = "/mcp";
export const MCP_SSE_PATH = "/mcp/sse";

/**
 * crawl4ai-mcp only ever speaks the legacy two-endpoint SSE transport:
 * opening `/mcp/sse` returns a `data: /mcp/messages/?session_id=...`
 * "endpoint" event, and the real JSON-RPC response to a submitted message
 * arrives as a *later* event on that same stream — never as the body of
 * the POST to the messages endpoint (confirmed live: that POST just 202s).
 * claude.ai's client instead speaks modern Streamable HTTP: one POST that
 * expects the JSON-RPC response inline. Neither a path rewrite nor forcing
 * "SSE" transport in the connector settings closes that gap (confirmed
 * live — the client still cancels after getting the `endpoint` event
 * instead of a real response), so the proxy bridges the two transports
 * itself: open crawl4ai's SSE session, submit the client's message to the
 * session endpoint, then read the same stream until the matching
 * JSON-RPC response event shows up.
 */
export function isMcpEntryPath(pathname: string): boolean {
	return pathname === MCP_PATH || pathname === MCP_SSE_PATH;
}

export interface SseFrame {
	event?: string;
	data: string;
}

/**
 * Incrementally parses SSE frames out of accumulated text. Returns the
 * complete frames found so far plus the unconsumed remainder, so a caller
 * can feed it one network chunk at a time without losing a frame split
 * across chunk boundaries. Comment lines (starting with `:`, e.g.
 * crawl4ai's keep-alive pings) are dropped; multi-line `data:` fields are
 * joined with `\n` per the SSE spec.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	const frames: SseFrame[] = [];
	for (const part of parts) {
		let event: string | undefined;
		const dataLines: string[] = [];
		for (const line of part.split("\n")) {
			if (line.startsWith(":")) continue;
			if (line.startsWith("event:")) event = line.slice("event:".length).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
		}
		if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
	}
	return { frames, rest };
}

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
	encodedRequest: string;
	error?: string;
}): string {
	const clientName = escapeHtml(options.clientName);
	const encodedRequest = escapeHtml(options.encodedRequest);
	const errorBanner = options.error
		? `<p style="color:#b91c1c">${escapeHtml(options.error)}</p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${clientName} to crawl4ai</title>
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
<h1>Connect to crawl4ai</h1>
<p><strong>${clientName}</strong> is requesting access to the crawl4ai-mcp server.</p>
${errorBanner}
<form method="post" action="${AUTHORIZE_PATH}">
<input type="hidden" name="oauth_request" value="${encodedRequest}">
<label for="token">crawl4ai API token</label>
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

const BRIDGE_TIMEOUT_MS = 20_000;

export function jsonRpcError(id: unknown, code: number, message: string): Response {
	return Response.json(
		{ jsonrpc: "2.0", id: id ?? null, error: { code, message } },
		{ status: 502 },
	);
}

/**
 * Wraps a single reader over crawl4ai's SSE session so the bridge can wait
 * for two different frames in sequence (the `endpoint` event, then later
 * the actual JSON-RPC response) without losing buffered bytes, the stream's
 * read lock, or already-parsed frames between waits. One network chunk can
 * easily contain multiple frames (e.g. the `endpoint` event immediately
 * followed by a ping) — any frame parsed but not consumed by the current
 * `waitFor` call is queued so the *next* call sees it first, instead of
 * being silently dropped. crawl4ai sends periodic `: ping` comments
 * throughout, dropped by `parseSseFrames` along with everything else that
 * doesn't match.
 */
export function createSseSessionReader(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const pending: SseFrame[] = [];
	return {
		async waitFor<T>(matches: (frame: SseFrame) => T | undefined): Promise<T> {
			while (!signal.aborted) {
				while (pending.length > 0) {
					const frame = pending.shift() as SseFrame;
					const result = matches(frame);
					if (result !== undefined) return result;
				}
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { frames, rest } = parseSseFrames(buffer);
				buffer = rest;
				pending.push(...frames);
			}
			throw new Error("crawl4ai's SSE session ended before a matching response arrived");
		},
		async close(): Promise<void> {
			await reader.cancel().catch(() => {});
		},
	};
}

/**
 * Bridges claude.ai's Streamable HTTP request (one POST, response expected
 * inline) to crawl4ai's legacy two-endpoint SSE transport: open crawl4ai's
 * SSE session, submit the client's JSON-RPC message to the session-scoped
 * endpoint it names, then read that same stream until the response with a
 * matching `id` shows up, and hand it back as a normal response. See
 * `isMcpEntryPath` above for why this exists at all.
 */
export async function bridgeMcpRequest(
	request: Request,
	upstreamOrigin: string,
	crawl4aiApiToken: string,
): Promise<Response> {
	const bodyText = await request.text();
	let requestId: unknown;
	try {
		requestId = (JSON.parse(bodyText) as { id?: unknown }).id;
	} catch {
		return jsonRpcError(null, -32700, "Invalid JSON-RPC request body");
	}
	// A notification (no id) gets no response by spec — fire the message and
	// stop, no need to hold a session open waiting for one that never comes.
	const isNotification = requestId === undefined || requestId === null;

	const authHeader = `Bearer ${crawl4aiApiToken}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
	let sessionReader: ReturnType<typeof createSseSessionReader> | undefined;
	try {
		const sseResponse = await fetch(new URL(MCP_SSE_PATH, upstreamOrigin), {
			headers: { authorization: authHeader, accept: "text/event-stream" },
			signal: controller.signal,
		});
		if (!sseResponse.ok || !sseResponse.body) {
			return jsonRpcError(requestId, -32000, `crawl4ai session open failed: ${sseResponse.status}`);
		}
		sessionReader = createSseSessionReader(sseResponse.body, controller.signal);

		const messagesPath = await sessionReader.waitFor((frame) =>
			frame.event === "endpoint" || frame.data.startsWith("/mcp/messages/")
				? frame.data
				: undefined,
		);

		const messagesResponse = await fetch(new URL(messagesPath, upstreamOrigin), {
			method: "POST",
			headers: { authorization: authHeader, "content-type": "application/json" },
			body: bodyText,
			signal: controller.signal,
		});
		if (!messagesResponse.ok) {
			return jsonRpcError(
				requestId,
				-32000,
				`crawl4ai rejected the message: ${messagesResponse.status}`,
			);
		}
		if (isNotification) return new Response(null, { status: 202 });

		const result = await sessionReader.waitFor((frame) => {
			try {
				const parsed = JSON.parse(frame.data) as { id?: unknown };
				return parsed.id === requestId ? parsed : undefined;
			} catch {
				return undefined;
			}
		});
		return Response.json(result);
	} catch (error) {
		if (controller.signal.aborted) {
			return jsonRpcError(requestId, -32000, "Timed out waiting for crawl4ai's response");
		}
		return jsonRpcError(requestId, -32000, error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timeout);
		await sessionReader?.close();
	}
}
