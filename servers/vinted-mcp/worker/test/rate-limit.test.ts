import { describe, expect, it, vi } from "vitest";
import { checkRateLimit, type RateLimitedEnv } from "../src/rate-limit";

function envWith(success: boolean): RateLimitedEnv {
	return { RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success }) } };
}

describe("checkRateLimit", () => {
	it("returns null (not limited) when the binding reports success", async () => {
		const env = envWith(true);
		const request = new Request("https://example.com/mcp", {
			headers: { "cf-connecting-ip": "203.0.113.1" },
		});
		expect(await checkRateLimit(request, env)).toBeNull();
		expect(env.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "203.0.113.1" });
	});

	it("returns a 429 with Retry-After when the binding reports failure", async () => {
		const env = envWith(false);
		const request = new Request("https://example.com/mcp");
		const response = await checkRateLimit(request, env);
		expect(response).not.toBeNull();
		expect(response!.status).toBe(429);
		expect(response!.headers.get("Retry-After")).toBe("60");
	});

	it("keys unknown-IP requests into a shared bucket instead of throwing", async () => {
		const env = envWith(true);
		const request = new Request("https://example.com/mcp");
		await checkRateLimit(request, env);
		expect(env.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "unknown" });
	});
});
