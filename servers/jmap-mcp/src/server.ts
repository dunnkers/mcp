import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ConfigEnv, loadJmapConfig, loadPolicy } from "./config.js";
import { ToolError } from "./errors.js";
import { type FetchLike, JmapClient } from "./jmap.js";
import {
	activateScript,
	deactivateScript,
	deleteScript,
	getCapabilities,
	getQuota,
	getScript,
	getVacation,
	listScripts,
	putScript,
	renameScript,
	setVacation,
	validateScript,
} from "./sieve.js";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
	return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Runs a tool body. ToolError messages are written to be shown to the client;
 * anything else is reported generically so internals (and anything a library
 * might have put in an error message) never reach the tool output.
 */
async function guarded(run: () => Promise<unknown>) {
	try {
		return textResult(await run());
	} catch (error) {
		if (error instanceof ToolError) return errorResult(error.message);
		console.error({ event: "tool.unexpected_error", name: error instanceof Error ? error.name : typeof error });
		return errorResult("Unexpected error while talking to the JMAP server.");
	}
}

const scriptRef = z.string().min(1).describe("Script id or exact script name");
const MAX_SCRIPT_CHARS = 256 * 1024;
const scriptContent = z.string().min(1).max(MAX_SCRIPT_CHARS).describe("Full Sieve script source");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Build a fresh MCP server instance. Reads no config until a tool is called. */
export function createJmapServer(env: ConfigEnv, fetchImpl?: FetchLike): McpServer {
	const server = new McpServer({ name: "jmap", version: "0.1.0" });
	const policy = loadPolicy(env);
	let client: JmapClient | null = null;
	const getClient = () => (client ??= new JmapClient(loadJmapConfig(env), fetchImpl));

	server.registerTool(
		"sieve_get_capabilities",
		{
			description:
				"Show the Sieve limits of the account (max script size/count/redirects, supported extensions) and this server's policy (denied actions, read-only mode). Check it before writing a script that uses extensions.",
			annotations: READ,
		},
		() => guarded(() => getCapabilities(getClient(), policy)),
	);

	server.registerTool(
		"sieve_list_scripts",
		{
			description: "List the Sieve scripts on the account with their ids, names and which one is active.",
			annotations: READ,
		},
		() => guarded(() => listScripts(getClient())),
	);

	server.registerTool(
		"sieve_get_script",
		{
			description: "Get the source of a Sieve script by id or name.",
			inputSchema: { script: scriptRef },
			annotations: READ,
		},
		({ script }) => guarded(() => getScript(getClient(), script)),
	);

	server.registerTool(
		"sieve_validate_script",
		{
			description:
				"Check Sieve source against the server's grammar and this server's policy without saving it. Syntax only: it cannot tell whether the rules do what the user intends.",
			inputSchema: { content: scriptContent },
			annotations: READ,
		},
		({ content }) => guarded(() => validateScript(getClient(), content, policy)),
	);

	if (!policy.readOnly) {
		server.registerTool(
			"sieve_put_script",
			{
				description:
					"Create a Sieve script, or replace the content of the script with the same name. The script is validated first and is NOT activated. Replacing the currently active script changes mail handling immediately, so it needs confirm_update_active: true; show the user the full new script and get their agreement first. Returns the previous content when replacing.",
				inputSchema: {
					name: z.string().min(1).max(255).describe("Script name"),
					content: scriptContent,
					confirm_update_active: z
						.boolean()
						.optional()
						.default(false)
						.describe("Required to overwrite the script that is currently active"),
				},
				annotations: DESTRUCTIVE,
			},
			({ name, content, confirm_update_active }) =>
				guarded(() => putScript(getClient(), policy, { name, content, confirmUpdateActive: confirm_update_active })),
		);

		server.registerTool(
			"sieve_activate_script",
			{
				description:
					"Make a script the active one; it replaces the currently active script (only one is active at a time) and starts filtering incoming mail immediately. Show the user the script and get their agreement first. The script is re-checked against the server policy.",
				inputSchema: { script: scriptRef },
				annotations: DESTRUCTIVE,
			},
			({ script }) => guarded(() => activateScript(getClient(), policy, script)),
		);

		server.registerTool(
			"sieve_deactivate_script",
			{
				description: "Deactivate the active script, so incoming mail is no longer filtered by any script. The script is kept.",
				annotations: DESTRUCTIVE,
			},
			() => guarded(() => deactivateScript(getClient())),
		);

		server.registerTool(
			"sieve_rename_script",
			{
				description: "Rename a Sieve script. Keeps its content and active state.",
				inputSchema: { script: scriptRef, new_name: z.string().min(1).max(255) },
				annotations: WRITE,
			},
			({ script, new_name }) => guarded(() => renameScript(getClient(), script, new_name)),
		);

		server.registerTool(
			"sieve_delete_script",
			{
				description:
					"Permanently delete a Sieve script. Deleting the active script also turns off filtering, so that needs deactivate_if_active: true and the user's agreement. Returns the deleted content so it can be restored.",
				inputSchema: {
					script: scriptRef,
					deactivate_if_active: z
						.boolean()
						.optional()
						.default(false)
						.describe("Required to delete the script that is currently active"),
				},
				annotations: DESTRUCTIVE,
			},
			({ script, deactivate_if_active }) => guarded(() => deleteScript(getClient(), script, deactivate_if_active)),
		);
	}

	server.registerTool(
		"vacation_get",
		{
			description:
				"Get the account's out-of-office (vacation) auto-reply: enabled flag, date range, subject and body.",
			annotations: READ,
		},
		() => guarded(() => getVacation(getClient())),
	);

	if (!policy.readOnly) {
		server.registerTool(
			"vacation_set",
			{
				description:
					"Update the out-of-office auto-reply. Only the fields you pass change. While enabled, senders receive the subject/body automatically, so confirm the wording with the user. Dates are UTC like 2026-08-01T00:00:00Z; pass null to clear a field.",
				inputSchema: {
					is_enabled: z.boolean().optional(),
					from_date: z.string().nullable().optional().describe("UTC start, or null for none"),
					to_date: z.string().nullable().optional().describe("UTC end, or null for none"),
					subject: z.string().max(998).nullable().optional(),
					text_body: z.string().max(10_000).nullable().optional(),
					html_body: z.string().max(20_000).nullable().optional(),
				},
				annotations: WRITE,
			},
			(args) =>
				guarded(async () => {
					const update = {
						...(args.is_enabled !== undefined && { isEnabled: args.is_enabled }),
						...(args.from_date !== undefined && { fromDate: args.from_date }),
						...(args.to_date !== undefined && { toDate: args.to_date }),
						...(args.subject !== undefined && { subject: args.subject }),
						...(args.text_body !== undefined && { textBody: args.text_body }),
						...(args.html_body !== undefined && { htmlBody: args.html_body }),
					};
					if (Object.keys(update).length === 0) throw new ToolError("Pass at least one field to change.");
					return setVacation(getClient(), update);
				}),
		);
	}

	server.registerTool(
		"get_quota",
		{
			description: "Show the account's storage quota usage and limits.",
			annotations: READ,
		},
		() => guarded(() => getQuota(getClient())),
	);

	return server;
}
