import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
// Reuse the vendored server as-is: it wires up all tools/resources/prompts
// on a raw @modelcontextprotocol/sdk Server. We only supply the transport.
// Imported via the `file:..` link (see package.json) rather than a `../../src`
// relative path, because wrangler's bundler doesn't resolve node_modules for
// files living outside its own project directory.
import { createServer } from "@andrijdavid/vinted-mcp/src/index";

// Split out from index.ts so tests can import it without pulling in oauth.ts,
// which requires @cloudflare/workers-oauth-provider's `cloudflare:workers`
// runtime module — that can't load under plain Node/vitest.
export async function handleMcpRequest(request: Request): Promise<Response> {
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
