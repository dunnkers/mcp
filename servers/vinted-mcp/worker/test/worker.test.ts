import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler";

// The Worker's HTTP entry point (`fetch` in src/index.ts) is now wrapped by
// @cloudflare/workers-oauth-provider: every /mcp request must carry a valid
// OAuth access token, checked against KV before handleMcpRequest ever runs.
// Exercising that end-to-end would mean faking KV and a full authorize/token
// exchange, which crawl4ai-proxy's and marktplaats-mcp's test suites (the
// pattern this follows) don't do either — instead they test the pure
// oauth-helpers.ts functions (see oauth-helpers.test.ts) and the actual MCP
// protocol logic directly against the exported request handler, bypassing
// the OAuth wrapper.
async function callMcp(body: unknown) {
	const request = new Request("https://example.com/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});
	return handleMcpRequest(request);
}

describe("handleMcpRequest", () => {
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
