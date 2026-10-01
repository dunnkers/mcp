import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const FIRE_PATH = "/v1/claude_code/routines/trig_01AyRCSkXRCRZLsnZd386Pru/fire";

const limiter = { limit: vi.fn() };
const env = { RATE_LIMITER: limiter as unknown as RateLimit };
const mockFetch = vi.fn();

function call(path: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://worker.example${path}`, init), env);
}

function lastUpstream() {
	const [url, init] = mockFetch.mock.calls.at(-1)! as [string, RequestInit];
	return { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
}

describe("claude-routine-webhook", () => {
	beforeEach(() => {
		limiter.limit.mockReset().mockResolvedValue({ success: true });
		mockFetch.mockReset().mockResolvedValue(
			new Response(JSON.stringify({ type: "routine_fire", session_id: "session_1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", mockFetch);
	});

	it("wraps an arbitrary JSON body into `text` and forwards it", async () => {
		const payload = JSON.stringify({ title: "Standup", transcript: "Hi all…" });
		const response = await call(FIRE_PATH, {
			method: "POST",
			headers: { authorization: "Bearer sk-ant-oat01-x", "content-type": "application/json" },
			body: payload,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: "routine_fire", session_id: "session_1" });
		const upstream = lastUpstream();
		expect(upstream.url).toBe(`https://api.anthropic.com${FIRE_PATH}`);
		expect(upstream.body).toEqual({ text: payload });
		expect(upstream.headers.get("authorization")).toBe("Bearer sk-ant-oat01-x");
		expect(upstream.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(upstream.headers.get("anthropic-beta")).toBe("experimental-cc-routine-2026-04-01");
		expect(upstream.headers.get("content-type")).toBe("application/json");
	});

	it("forwards non-JSON bodies verbatim and honours caller-set anthropic headers", async () => {
		await call(`${FIRE_PATH}/`, {
			method: "PUT",
			headers: { authorization: "Bearer t", "anthropic-beta": "some-other-beta" },
			body: "plain text notes",
		});
		const upstream = lastUpstream();
		expect(upstream.url).toBe(`https://api.anthropic.com${FIRE_PATH}`);
		expect(upstream.body).toEqual({ text: "plain text notes" });
		expect(upstream.headers.get("anthropic-beta")).toBe("some-other-beta");
	});

	it("fires without `text` when the body is empty", async () => {
		await call(FIRE_PATH, { method: "POST", headers: { authorization: "Bearer t" } });
		expect(lastUpstream().body).toEqual({});
	});

	it("relays upstream errors", async () => {
		mockFetch.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
		const response = await call(FIRE_PATH, {
			method: "POST",
			headers: { authorization: "Bearer wrong" },
			body: "{}",
		});
		expect(response.status).toBe(401);
		expect(await response.text()).toBe('{"error":"unauthorized"}');
	});

	it("rejects other paths, methods and missing auth without calling upstream", async () => {
		expect((await call("/v1/messages", { method: "POST", headers: { authorization: "Bearer t" } })).status).toBe(404);
		expect((await call("/v1/claude_code/routines/../../x/fire", { method: "POST" })).status).toBe(404);
		expect((await call(FIRE_PATH, { method: "GET", headers: { authorization: "Bearer t" } })).status).toBe(405);
		expect((await call(FIRE_PATH, { method: "POST", body: "{}" })).status).toBe(401);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns 429 when rate limited", async () => {
		limiter.limit.mockResolvedValue({ success: false });
		const response = await call(FIRE_PATH, { method: "POST", headers: { authorization: "Bearer t" }, body: "x" });
		expect(response.status).toBe(429);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
