import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

async function callMcp(body: unknown) {
	const request = new Request("https://example.com/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});
	return worker.fetch(request, {} as never, {} as never);
}

describe("worker fetch handler", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	it("serves a root info document", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/"),
			{} as never,
			{} as never,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ name: "marktplaats-mcp", mcp_endpoint: "/mcp" });
	});

	it("returns 404 for unknown paths", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/nope"),
			{} as never,
			{} as never,
		);
		expect(response.status).toBe(404);
	});

	it("rejects GET and DELETE on /mcp", async () => {
		for (const method of ["GET", "DELETE"]) {
			const response = await worker.fetch(
				new Request("https://example.com/mcp", { method }),
				{} as never,
				{} as never,
			);
			expect(response.status).toBe(405);
		}
	});

	it("lists all registered tools via the MCP protocol", async () => {
		await callMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			},
		});

		const response = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { tools: { name: string }[] };
		};
		const names = body.result.tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"get_category_filters",
			"get_listing_details",
			"get_seller_info",
			"list_categories",
			"search_listings",
		]);
	});

	it("calls the list_categories tool end-to-end over JSON-RPC", async () => {
		const response = await callMcp({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "list_categories", arguments: {} },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { content: { type: string; text: string }[] };
		};
		const payload = JSON.parse(body.result.content[0]!.text);
		expect(payload.main_categories).toContainEqual({ name: "Boeken", id: 201 });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("calls search_listings end-to-end and reaches the Marktplaats API", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ totalResultCount: 0, listings: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const response = await callMcp({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "search_listings", arguments: { query: "fiets", compact: true } },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { content: { type: string; text: string }[] };
		};
		const payload = JSON.parse(body.result.content[0]!.text);
		expect(payload).toEqual({ total: 0, listings: [] });
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(mockFetch.mock.calls[0]![0] as string);
		expect(requestedUrl.hostname).toBe("www.marktplaats.nl");
		expect(requestedUrl.searchParams.get("query")).toBe("fiets");
	});
});
