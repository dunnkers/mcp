import { describe, expect, it } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
	decodeAuthRequest,
	encodeAuthRequest,
	renderAuthorizePage,
	tokensMatch,
	upstreamPath,
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

describe("upstreamPath", () => {
	it("rewrites the bare /mcp connector path to crawl4ai's real /mcp/sse endpoint", () => {
		expect(upstreamPath("/mcp")).toBe("/mcp/sse");
	});

	it("passes through the SSE session's own follow-up messages path unchanged", () => {
		expect(upstreamPath("/mcp/messages/")).toBe("/mcp/messages/");
	});

	it("leaves unrelated paths unchanged", () => {
		expect(upstreamPath("/authorize")).toBe("/authorize");
		expect(upstreamPath("/mcp/sse")).toBe("/mcp/sse");
	});
});
