import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// Reuse the vendored server as-is: it wires up all tools/resources/prompts
// on a raw @modelcontextprotocol/sdk Server. We only supply the transport.
// Imported via the `file:..` link (see package.json) rather than a `../../src`
// relative path, because wrangler's bundler doesn't resolve node_modules for
// files living outside its own project directory.
import { createServer } from "@andrijdavid/vinted-mcp/src/index";

async function handleMcpRequest(request: Request): Promise<Response> {
	const server = createServer();
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: no Durable Object, no session state kept between requests.
		sessionIdGenerator: undefined,
		// A single JSON body instead of an SSE stream, so we can safely close
		// the transport/server right after the response is built.
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await transport.close();
		await server.close();
	}
}

export default {
	async fetch(request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			if (request.method === "GET" || request.method === "DELETE") {
				return Response.json(
					{
						jsonrpc: "2.0",
						error: { code: -32000, message: "Method not allowed." },
						id: null,
					},
					{ status: 405 },
				);
			}
			return handleMcpRequest(request);
		}

		if (url.pathname === "/" || url.pathname === "") {
			return Response.json({
				name: "vinted-mcp",
				description:
					"MCP server for searching and comparing Vinted marketplace listings across 19 countries.",
				mcp_endpoint: "/mcp",
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler;
