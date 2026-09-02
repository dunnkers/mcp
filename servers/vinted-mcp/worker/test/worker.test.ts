import { describe, expect, it } from "vitest";
import worker from "../src/index";

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

describe("vinted-mcp worker fetch handler", () => {
	it("serves a root info document", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/"),
			{} as never,
			{} as never,
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ name: "vinted-mcp", mcp_endpoint: "/mcp" });
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

	it("lists all vendored tools via the MCP protocol", async () => {
		const response = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { tools: { name: string }[] } };
		const names = body.result.tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"compare_prices",
			"get_item",
			"get_seller",
			"get_trending",
			"like_item",
			"search_items",
		]);
	});

	it("lists the vendored resources and reads the static countries resource", async () => {
		const listResponse = await callMcp({ jsonrpc: "2.0", id: 2, method: "resources/list" });
		const listBody = (await listResponse.json()) as {
			result: { resources: { uri: string }[] };
		};
		expect(listBody.result.resources.map((r) => r.uri)).toContain("vinted://countries");

		const readResponse = await callMcp({
			jsonrpc: "2.0",
			id: 3,
			method: "resources/read",
			params: { uri: "vinted://countries" },
		});
		const readBody = (await readResponse.json()) as {
			result: { contents: { text: string }[] };
		};
		const countries = JSON.parse(readBody.result.contents[0]!.text);
		expect(countries).toContainEqual(
			expect.objectContaining({ code: "fr", domain: "www.vinted.fr" }),
		);
	});

	it("returns a JSON-RPC error for an unknown tool, without touching the network", async () => {
		const response = await callMcp({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "not_a_real_tool", arguments: {} },
		});
		const body = (await response.json()) as {
			result: { content: { text: string }[]; isError?: boolean };
		};
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0]!.text).toContain("Unknown tool");
	});
});
