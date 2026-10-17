/**
 * Errors whose message is safe to show the MCP client verbatim (no
 * credentials, no URLs with secrets). Anything else is reported generically by
 * the tool wrapper in server.ts.
 */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

/** Missing or malformed Worker configuration. */
export class ConfigError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** A script or request refused by the server's own policy (DENY_SIEVE_ACTIONS, READ_ONLY, ...). */
export class PolicyError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "PolicyError";
	}
}

/** The JMAP server answered with an error, or could not be reached. */
export class JmapError extends ToolError {
	constructor(
		message: string,
		readonly type?: string,
	) {
		super(message);
		this.name = "JmapError";
	}
}
