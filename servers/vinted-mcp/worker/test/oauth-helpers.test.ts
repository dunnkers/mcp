import { describe, expect, it } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
	authRequestProblem,
	DEFAULT_ALLOWED_REDIRECT_HOSTS,
	decodeAuthRequest,
	encodeAuthRequest,
	isAllowedRedirectUri,
	isUsableAuthToken,
	parseAllowedRedirectHosts,
	renderAuthorizePage,
	tokensMatch,
} from "../src/oauth-helpers";

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
			redirectHost: "<evil>",
			encodedRequest: "abc.123",
		});
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain('value="abc.123"');
		expect(html).toContain("&lt;evil&gt;");
	});

	it("shows the error banner only when an error is passed", () => {
		const withoutError = renderAuthorizePage({
			clientName: "claude.ai",
			redirectHost: "claude.ai",
			encodedRequest: "x",
		});
		const withError = renderAuthorizePage({
			clientName: "claude.ai",
			redirectHost: "claude.ai",
			encodedRequest: "x",
			error: "Incorrect token.",
		});
		expect(withoutError).not.toContain("Incorrect token.");
		expect(withError).toContain("Incorrect token.");
	});
});

describe("parseAllowedRedirectHosts", () => {
	it("defaults to claude.ai and claude.com", () => {
		expect(parseAllowedRedirectHosts(undefined)).toEqual(DEFAULT_ALLOWED_REDIRECT_HOSTS);
		expect(parseAllowedRedirectHosts(" , ")).toEqual(DEFAULT_ALLOWED_REDIRECT_HOSTS);
	});

	it("parses a comma-separated override, trimmed and lowercased", () => {
		expect(parseAllowedRedirectHosts(" Claude.ai, chatgpt.com ")).toEqual([
			"claude.ai",
			"chatgpt.com",
		]);
	});
});

describe("isAllowedRedirectUri", () => {
	const hosts = DEFAULT_ALLOWED_REDIRECT_HOSTS;

	it("allows claude.ai's connector callback", () => {
		expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", hosts)).toBe(true);
		expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback", hosts)).toBe(true);
	});

	it("allows loopback redirects used by desktop/CLI clients", () => {
		expect(isAllowedRedirectUri("http://localhost:33418/callback", hosts)).toBe(true);
		expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb", hosts)).toBe(true);
		expect(isAllowedRedirectUri("http://[::1]:8080/cb", hosts)).toBe(true);
	});

	it("rejects other hosts, lookalikes, plain http, and credentials", () => {
		expect(isAllowedRedirectUri("https://evil.example/cb", hosts)).toBe(false);
		expect(isAllowedRedirectUri("https://claude.ai.evil.example/cb", hosts)).toBe(false);
		expect(isAllowedRedirectUri("https://evilclaude.ai/cb", hosts)).toBe(false);
		expect(isAllowedRedirectUri("http://claude.ai/cb", hosts)).toBe(false);
		expect(isAllowedRedirectUri("https://user@claude.ai/cb", hosts)).toBe(false);
		expect(isAllowedRedirectUri("javascript:alert(1)", hosts)).toBe(false);
		expect(isAllowedRedirectUri("not a url", hosts)).toBe(false);
	});
});

describe("authRequestProblem", () => {
	const hosts = DEFAULT_ALLOWED_REDIRECT_HOSTS;

	it("accepts a claude.ai authorization code request with S256 PKCE", () => {
		expect(authRequestProblem(SAMPLE_AUTH_REQUEST, hosts)).toBeNull();
	});

	it("rejects requests without S256 PKCE", () => {
		expect(
			authRequestProblem({ ...SAMPLE_AUTH_REQUEST, codeChallenge: undefined }, hosts),
		).toMatch(/PKCE/);
		expect(
			authRequestProblem({ ...SAMPLE_AUTH_REQUEST, codeChallengeMethod: "plain" }, hosts),
		).toMatch(/PKCE/);
	});

	it("rejects non-code response types", () => {
		expect(authRequestProblem({ ...SAMPLE_AUTH_REQUEST, responseType: "token" }, hosts)).toMatch(
			/authorization code/,
		);
	});

	it("rejects redirects outside the allowlist", () => {
		expect(
			authRequestProblem({ ...SAMPLE_AUTH_REQUEST, redirectUri: "https://evil.example/cb" }, hosts),
		).toMatch(/evil\.example/);
	});
});

describe("isUsableAuthToken", () => {
	it("rejects missing and short tokens", () => {
		expect(isUsableAuthToken(undefined)).toBe(false);
		expect(isUsableAuthToken("")).toBe(false);
		expect(isUsableAuthToken("hunter2")).toBe(false);
		expect(isUsableAuthToken(`${" ".repeat(40)}x`)).toBe(false);
	});

	it("accepts a 32+ character token", () => {
		expect(isUsableAuthToken("a".repeat(32))).toBe(true);
	});
});
