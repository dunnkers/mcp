import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ConfigEnv } from "./config.js";
import type { FetchLike } from "./jmap.js";
import { createJmapServer } from "./server.js";

// Split out from index.ts so tests can import it without pulling in oauth.ts,
// which requires @cloudflare/workers-oauth-provider's `cloudflare:workers`
// runtime module — that can't load under plain Node/vitest.
export async function handleMcpRequest(
	request: Request,
	env: ConfigEnv,
	fetchImpl?: FetchLike,
): Promise<Response> {
	const server = createJmapServer(env, fetchImpl);
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: every request is independent. The JMAP session is
		// re-fetched per request; nothing is kept between calls.
		sessionIdGenerator: undefined,
		// A single JSON body instead of an SSE stream; tool calls are plain
		// request/response.
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
