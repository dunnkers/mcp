import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import worker from "../src/index.js";
import { resetTokenCache } from "../src/auth.js";
import { normalizeMimeType, sniffMimeType } from "../src/input.js";
import type { Env } from "../src/env.js";

const AUTH = "a".repeat(40);
const jwk = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
const limiter = { limit: vi.fn() };
const env: Env = {
	RATE_LIMITER: limiter as unknown as RateLimit,
	AUTH_TOKEN: AUTH,
	OIDC_PRIVATE_KEY_JWK: JSON.stringify({ ...jwk, kid: "k1" }),
	WIF_AUDIENCE: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/p/providers/w",
	GCP_PROJECT_ID: "voice-memo-summarizer",
	GCS_BUCKET: "voice-memo-summarizer-storage",
	VERTEX_LOCATION: "global",
	GEMINI_MODEL: "gemini-3.8-flash",
	SERVICE_ACCOUNT_EMAIL: "sa@voice-memo-summarizer.iam.gserviceaccount.com",
};

const mockFetch = vi.fn();
const calls = () => mockFetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));

function call(body: BodyInit | null, headers: Record<string, string> = {}, path = "/") {
	return worker.fetch(
		new Request(`https://worker.example${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${AUTH}`, ...headers },
			body,
		}),
		env,
	);
}

beforeEach(() => {
	resetTokenCache();
	limiter.limit.mockReset().mockResolvedValue({ success: true });
	mockFetch.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
		const url = String(input);
		const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
		if (url.startsWith("https://sts.googleapis.com")) return ok({ access_token: "fed", expires_in: 3600 });
		if (url.includes("iamcredentials")) return ok({ accessToken: "sa-token", expireTime: new Date(Date.now() + 3600_000).toISOString() });
		if (url.includes("storage.googleapis.com/upload")) return ok({});
		if (url.includes("storage.googleapis.com/storage")) return new Response(null, { status: 204 });
		if (url.includes("aiplatform.googleapis.com")) return ok({ candidates: [{ content: { parts: [{ text: "  Transcript: hello  " }] } }] });
		throw new Error(`unexpected ${url}`);
	});
	vi.stubGlobal("fetch", mockFetch);
});

describe("auth and routing", () => {
	it("rejects missing/incorrect bearer tokens", async () => {
		const response = await worker.fetch(new Request("https://worker.example/", { method: "POST", body: "x" }), env);
		expect(response.status).toBe(401);
		const wrong = await call("x", { authorization: "Bearer nope" });
		expect(wrong.status).toBe(401);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rate limits before anything else", async () => {
		limiter.limit.mockResolvedValue({ success: false });
		expect((await call("x")).status).toBe(429);
	});

	it("serves OIDC discovery and a public-only JWKS without auth", async () => {
		const discovery = await (await worker.fetch(new Request("https://worker.example/.well-known/openid-configuration"), env)).json() as any;
		expect(discovery.issuer).toBe("https://worker.example");
		expect(discovery.jwks_uri).toBe("https://worker.example/.well-known/jwks.json");
		const jwks = await (await worker.fetch(new Request("https://worker.example/.well-known/jwks.json"), env)).json() as any;
		expect(jwks.keys[0]).toMatchObject({ kty: "RSA", kid: "k1", alg: "RS256" });
		expect(jwks.keys[0].d).toBeUndefined();
	});
});

describe("summarizing", () => {
	it("sends JSON as text, using WIF + service account impersonation", async () => {
		const response = await call('{"a":1}', { "content-type": "application/json" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Transcript: hello");

		const [sts, iam, gemini] = calls();
		const stsBody = JSON.parse(sts!.init.body as string);
		expect(stsBody.audience).toBe(env.WIF_AUDIENCE);
		const [header, claims] = stsBody.subjectToken.split(".").slice(0, 2).map((p: string) => JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))));
		expect(header).toMatchObject({ alg: "RS256", kid: "k1" });
		expect(claims).toMatchObject({ iss: "https://worker.example", aud: env.WIF_AUDIENCE });
		expect(iam!.url).toContain("sa%40voice-memo-summarizer.iam.gserviceaccount.com:generateAccessToken");
		expect(new Headers(iam!.init.headers).get("authorization")).toBe("Bearer fed");

		expect(gemini!.url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/voice-memo-summarizer/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
		);
		const headers = new Headers(gemini!.init.headers);
		expect(headers.get("authorization")).toBe("Bearer sa-token");
		expect(headers.get("x-goog-api-key")).toBeNull();
		const body = JSON.parse(gemini!.init.body as string);
		expect(body.contents[0].parts[0].text).toBe('{"a":1}');
		expect(body.systemInstruction.parts[0].text).toContain("truthful");
	});

	it("uploads a raw audio body to the bucket, references it by gs:// URI, and cleans up", async () => {
		const m4a = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 1, 2, 3]);
		const response = await call(m4a, { "content-type": "application/octet-stream" });
		expect(response.status).toBe(200);

		const all = calls();
		const upload = all.find((c) => c.url.includes("/upload/storage/v1/b/voice-memo-summarizer-storage/o"))!;
		expect(new Headers(upload.init.headers).get("content-type")).toBe("audio/mp4");
		expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer sa-token");
		const gemini = all.find((c) => c.url.includes("aiplatform"))!;
		const part = JSON.parse(gemini.init.body as string).contents[0].parts.find((p: any) => p.fileData);
		expect(part.fileData.mimeType).toBe("audio/mp4");
		expect(part.fileData.fileUri).toMatch(/^gs:\/\/voice-memo-summarizer-storage\/uploads\/.+\.m4a$/);
		expect(all.some((c) => c.init.method === "DELETE")).toBe(true);
	});

	it("handles multipart with a file and a text field", async () => {
		const form = new FormData();
		form.set("note", "from my phone");
		form.set("memo", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "doc.bin"));
		const response = await call(form);
		expect(response.status).toBe(200);
		const gemini = calls().find((c) => c.url.includes("aiplatform"))!;
		const parts = JSON.parse(gemini.init.body as string).contents[0].parts;
		expect(parts[0].text).toContain("from my phone");
		expect(parts.find((p: any) => p.fileData).fileData.mimeType).toBe("application/pdf");
	});

	it("reuses the access token across requests", async () => {
		await call("one");
		await call("two");
		expect(calls().filter((c) => c.url.includes("sts.googleapis.com"))).toHaveLength(1);
	});

	it("rejects empty and unsupported input without calling Google", async () => {
		expect((await call(null)).status).toBe(400);
		expect((await call(new Uint8Array([0x50, 0x4b, 3, 4, 0, 1]), { "content-type": "application/zip" })).status).toBe(415);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("reports upstream failures as 502", async () => {
		mockFetch.mockImplementation(async () => new Response("denied", { status: 403 }));
		const response = await call("hi");
		expect(response.status).toBe(502);
		expect(await response.text()).toContain("403");
	});
});

describe("mime helpers", () => {
	it("normalises Apple/odd types and sniffs magic bytes", () => {
		expect(normalizeMimeType("audio/x-m4a; charset=binary")).toBe("audio/mp4");
		expect(sniffMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBe("audio/wav");
		expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffMimeType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
	});
});
