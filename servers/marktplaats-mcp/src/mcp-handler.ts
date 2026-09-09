import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMarktplaatsServer } from "./server.js";

// Split out from index.ts so tests can import it without pulling in oauth.ts,
// which requires @cloudflare/workers-oauth-provider's `cloudflare:workers`
// runtime module — that can't load under plain Node/vitest (same reasoning
// as oauth-helpers.ts in this file's sibling).
export async function handleMcpRequest(request: Request): Promise<Response> {
	const server = createMarktplaatsServer();
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: every request is independent, there's nothing to search
		// Marktplaats for that needs a session (no per-user state — the MCP
		// session itself is stateless; access is still gated by OAuth, see
		// oauth.ts).
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
