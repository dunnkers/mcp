import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

function fetchWorker(path: string, init?: RequestInit) {
	const request = new Request(`https://proxy.example.com${path}`, init);
	return worker.fetch(request, {} as never, {} as never);
}

describe("crawl4ai-proxy", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("rejects requests with no token", async () => {
		const response = await fetchWorker("/mcp/sse", { method: "POST" });
		expect(response.status).toBe(401);
	});

	it("forwards the token as a Bearer header and strips it from the upstream URL", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
		);

		const response = await fetchWorker("/mcp/sse?token=secret-123", { method: "POST" });

		expect(response.status).toBe(200);
		const [upstreamUrl, upstreamInit] = mockFetch.mock.calls[0]!;
		expect(String(upstreamUrl)).toBe(
			"https://crawl4ai-mcp-500845880919.europe-west4.run.app/mcp/sse",
		);
		const headers = new Headers((upstreamInit as RequestInit).headers);
		expect(headers.get("authorization")).toBe("Bearer secret-123");
	});

	it("preserves other query params while stripping token", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(new Response("ok", { status: 202 }));

		await fetchWorker("/mcp/messages/?session_id=abc123&token=secret-123", { method: "POST" });

		const [upstreamUrl] = mockFetch.mock.calls[0]!;
		expect(String(upstreamUrl)).toBe(
			"https://crawl4ai-mcp-500845880919.europe-west4.run.app/mcp/messages/?session_id=abc123",
		);
	});

	it("rewrites the SSE endpoint event to carry the token forward", async () => {
		const mockFetch = vi.mocked(fetch);
		const sseBody = "event: endpoint\ndata: /mcp/messages/?session_id=abc123\n\n";
		mockFetch.mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "content-type": "text/event-stream; charset=utf-8" },
			}),
		);

		const response = await fetchWorker("/mcp/sse?token=secret-123", { method: "POST" });
		const text = await response.text();

		expect(text).toContain("data: /mcp/messages/?session_id=abc123&token=secret-123");
	});

	it("passes non-SSE bodies through untouched", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockResolvedValue(
			new Response('{"ok":true}', { status: 202, headers: { "content-type": "application/json" } }),
		);

		const response = await fetchWorker("/mcp/messages/?session_id=abc123&token=secret-123", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0" }),
		});

		expect(await response.json()).toEqual({ ok: true });
	});
});
