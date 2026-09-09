import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
	bridgeMcpRequest,
	decodeAuthRequest,
	encodeAuthRequest,
	isMcpEntryPath,
	parseSseFrames,
	renderAuthorizePage,
	tokensMatch,
} from "../src/oauth-helpers.js";

const SAMPLE_AUTH_REQUEST: AuthRequest = {
	responseType: "code",
	clientId: "claude-ai",
	redirectUri: "https://claude.ai/callback",
	scope: ["mcp"],
	state: "xyz",
	codeChallenge: "abc123",
	codeChallengeMethod: "S256",
};

describe("encodeAuthRequest / decodeAuthRequest", () => {
	it("round-trips an auth request through the URL-safe base64 encoding", () => {
		const encoded = encodeAuthRequest(SAMPLE_AUTH_REQUEST);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(decodeAuthRequest(encoded)).toEqual(SAMPLE_AUTH_REQUEST);
	});

	it("returns null for garbage input instead of throwing", () => {
		expect(decodeAuthRequest("not-valid-base64!!!")).toBeNull();
	});
});

describe("tokensMatch", () => {
	it("matches identical tokens", async () => {
		expect(await tokensMatch("secret-123", "secret-123")).toBe(true);
	});

	it("rejects different tokens, including differing only by length", async () => {
		expect(await tokensMatch("secret-123", "secret-1234")).toBe(false);
		expect(await tokensMatch("secret-123", "wrong")).toBe(false);
	});
});

describe("renderAuthorizePage", () => {
	it("escapes untrusted client name and encoded request into the HTML", () => {
		const html = renderAuthorizePage({
			clientName: '<script>alert("x")</script>',
			encodedRequest: "abc.123",
		});
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain('value="abc.123"');
	});

	it("shows the error banner only when an error is passed", () => {
		const withoutError = renderAuthorizePage({ clientName: "claude.ai", encodedRequest: "x" });
		const withError = renderAuthorizePage({
			clientName: "claude.ai",
			encodedRequest: "x",
			error: "Incorrect token.",
		});
		expect(withoutError).not.toContain("Incorrect token.");
		expect(withError).toContain("Incorrect token.");
	});
});

describe("isMcpEntryPath", () => {
	it("matches both paths claude.ai has been observed connecting to", () => {
		expect(isMcpEntryPath("/mcp")).toBe(true);
		expect(isMcpEntryPath("/mcp/sse")).toBe(true);
	});

	it("does not match crawl4ai's internal session-messages path or anything else", () => {
		expect(isMcpEntryPath("/mcp/messages/")).toBe(false);
		expect(isMcpEntryPath("/authorize")).toBe(false);
	});
});

describe("parseSseFrames", () => {
	it("parses a complete frame and returns no remainder", () => {
		const { frames, rest } = parseSseFrames("event: endpoint\ndata: /mcp/messages/?session_id=abc\n\n");
		expect(frames).toEqual([{ event: "endpoint", data: "/mcp/messages/?session_id=abc" }]);
		expect(rest).toBe("");
	});

	it("holds back a partial trailing frame for the next chunk", () => {
		const { frames, rest } = parseSseFrames("event: endpoint\ndata: /mcp/messages/?session_id=abc\n\ndata: partial");
		expect(frames).toEqual([{ event: "endpoint", data: "/mcp/messages/?session_id=abc" }]);
		expect(rest).toBe("data: partial");
	});

	it("drops comment lines (crawl4ai's keep-alive pings)", () => {
		const { frames } = parseSseFrames(": ping - 2026-09-09\n\ndata: hello\n\n");
		expect(frames).toEqual([{ data: "hello" }]);
	});

	it("joins multi-line data fields with newlines", () => {
		const { frames } = parseSseFrames('data: {"a":1,\ndata: "b":2}\n\n');
		expect(frames).toEqual([{ data: '{"a":1,\n"b":2}' }]);
	});

	it("ignores frames with no data lines", () => {
		const { frames } = parseSseFrames("event: ping\n\ndata: hello\n\n");
		expect(frames).toEqual([{ data: "hello" }]);
	});
});

function sseStreamFrom(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

describe("bridgeMcpRequest", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("bridges a JSON-RPC request through crawl4ai's two-endpoint SSE session", async () => {
		const sseBody = sseStreamFrom(
			": ping - now\n\n" +
				"event: endpoint\ndata: /mcp/messages/?session_id=abc123\n\n" +
				": ping - now\n\n" +
				'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
		);
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockImplementation(async (url) => {
			const href = String(url);
			if (href.endsWith("/mcp/sse")) {
				return new Response(sseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			if (href.includes("/mcp/messages/")) {
				return new Response(null, { status: 202 });
			}
			throw new Error(`unexpected fetch: ${href}`);
		});

		const request = new Request("https://proxy.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		const response = await bridgeMcpRequest(request, "https://upstream.example.com", "real-token");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });

		// The message POST must carry the real upstream token, not whatever claude.ai sent.
		const messagesCall = mockFetch.mock.calls.find(([url]) => String(url).includes("/mcp/messages/"));
		expect(messagesCall).toBeDefined();
		const [, init] = messagesCall!;
		const headers = new Headers((init as RequestInit).headers);
		expect(headers.get("authorization")).toBe("Bearer real-token");
	});

	it("returns 202 immediately for a notification (no id) without waiting for a response event", async () => {
		const sseBody = sseStreamFrom("event: endpoint\ndata: /mcp/messages/?session_id=abc123\n\n");
		vi.mocked(fetch).mockImplementation(async (url) => {
			const href = String(url);
			if (href.endsWith("/mcp/sse")) {
				return new Response(sseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(null, { status: 202 });
		});

		const request = new Request("https://proxy.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		const response = await bridgeMcpRequest(request, "https://upstream.example.com", "real-token");
		expect(response.status).toBe(202);
	});

	it("returns a JSON-RPC error if crawl4ai's session fails to open", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
		const request = new Request("https://proxy.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		const response = await bridgeMcpRequest(request, "https://upstream.example.com", "real-token");
		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain("500");
	});
});
