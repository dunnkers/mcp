import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMarktplaatsServer } from "./server.js";

async function handleMcpRequest(request: Request): Promise<Response> {
	const server = createMarktplaatsServer();
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: every request is independent, there's nothing to search
		// Marktplaats for that needs a session (no auth, no per-user state).
		sessionIdGenerator: undefined,
		// Return a single complete JSON body instead of an SSE stream: simple
		// request/response tool calls don't need streaming, and it lets us
		// close the transport/server right after the response is built.
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
				name: "marktplaats-mcp",
				description: "MCP server for searching and browsing Marktplaats.nl listings.",
				mcp_endpoint: "/mcp",
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler;
