import type { Policy } from "./config.js";
import { JmapError, PolicyError, ToolError } from "./errors.js";
import {
	CORE,
	type JmapClient,
	QUOTA,
	responseFor,
	SIEVE,
	type SetError,
	throwSetError,
	VACATION,
} from "./jmap.js";
import { findDeniedActions } from "./lint.js";

const USING = [CORE, SIEVE];
const SCRIPT_TYPE = "application/sieve";

export interface SieveScript {
	id: string;
	name: string;
	blobId?: string;
	isActive: boolean;
}

export function assertPolicy(content: string, policy: Policy): void {
	const denied = findDeniedActions(content, policy.deniedActions);
	if (denied.length > 0) {
		throw new PolicyError(
			`This server's policy does not allow scripts that use: ${denied.join(", ")} (DENY_SIEVE_ACTIONS). Remove them, or have the operator change the setting.`,
		);
	}
}

export async function listScripts(client: JmapClient): Promise<SieveScript[]> {
	const accountId = await client.accountId(SIEVE);
	const responses = await client.call(USING, [
		["SieveScript/get", { accountId, ids: null, properties: ["id", "name", "blobId", "isActive"] }],
	]);
	const list = responseFor(responses, "c0").list as SieveScript[] | undefined;
	return (list ?? []).map((s) => ({ id: s.id, name: s.name, blobId: s.blobId, isActive: Boolean(s.isActive) }));
}

/** Find a script by id or, failing that, by exact name. */
export async function resolveScript(client: JmapClient, ref: string): Promise<SieveScript> {
	const scripts = await listScripts(client);
	const found = scripts.find((s) => s.id === ref) ?? scripts.find((s) => s.name === ref);
	if (!found) throw new ToolError(`No Sieve script with id or name "${ref}".`);
	return found;
}

export async function readScript(client: JmapClient, script: SieveScript): Promise<string> {
	if (!script.blobId) throw new JmapError("The server did not return a blobId for this script.");
	return client.download(script.blobId, `${script.name}.sieve`, SCRIPT_TYPE);
}

export async function getScript(client: JmapClient, ref: string) {
	const script = await resolveScript(client, ref);
	return { id: script.id, name: script.name, isActive: script.isActive, content: await readScript(client, script) };
}

export async function validateContent(
	client: JmapClient,
	content: string,
): Promise<{ valid: boolean; error?: string; blobId: string }> {
	const accountId = await client.accountId(SIEVE);
	const blobId = await client.upload(content, SCRIPT_TYPE);
	const responses = await client.call(USING, [["SieveScript/validate", { accountId, blobId }]]);
	const error = responseFor(responses, "c0").error as SetError | null | undefined;
	if (!error) return { valid: true, blobId };
	return {
		valid: false,
		blobId,
		error: `${error.type ?? "invalidSieve"}${error.description ? `: ${error.description}` : ""}`,
	};
}

export async function validateScript(client: JmapClient, content: string, policy: Policy) {
	const result = await validateContent(client, content);
	const denied = findDeniedActions(content, policy.deniedActions);
	return {
		valid: result.valid && denied.length === 0,
		syntaxError: result.error ?? null,
		deniedActions: denied,
	};
}

export async function putScript(
	client: JmapClient,
	policy: Policy,
	args: { name: string; content: string; confirmUpdateActive: boolean },
) {
	assertPolicy(args.content, policy);
	const accountId = await client.accountId(SIEVE);
	const existing = (await listScripts(client)).find((s) => s.name === args.name);
	if (existing?.isActive && !args.confirmUpdateActive) {
		throw new PolicyError(
			`"${args.name}" is the active script, so changing it takes effect on incoming mail immediately. Show the user the new script and, once they agree, retry with confirm_update_active: true.`,
		);
	}
	const previousContent = existing ? await readScript(client, existing) : null;
	const checked = await validateContent(client, args.content);
	if (!checked.valid) throw new ToolError(`The script is not valid Sieve — ${checked.error}`);

	const set = existing
		? { update: { [existing.id]: { blobId: checked.blobId } } }
		: { create: { new: { name: args.name, blobId: checked.blobId } } };
	const responses = await client.call(USING, [["SieveScript/set", { accountId, ...set }]]);
	const result = responseFor(responses, "c0");
	if (existing) {
		throwSetError("update the script", (result.notUpdated as Record<string, SetError> | undefined)?.[existing.id]);
	} else {
		throwSetError("create the script", (result.notCreated as Record<string, SetError> | undefined)?.new);
	}
	const created = (result.created as Record<string, { id: string }> | undefined)?.new;
	return {
		action: existing ? "updated" : "created",
		id: existing?.id ?? created?.id ?? null,
		name: args.name,
		isActive: existing?.isActive ?? false,
		previousContent,
	};
}

export async function activateScript(client: JmapClient, policy: Policy, ref: string) {
	const script = await resolveScript(client, ref);
	assertPolicy(await readScript(client, script), policy);
	const accountId = await client.accountId(SIEVE);
	const previouslyActive = (await listScripts(client)).find((s) => s.isActive && s.id !== script.id);
	const responses = await client.call(USING, [
		["SieveScript/set", { accountId, onSuccessActivateScript: script.id }],
	]);
	responseFor(responses, "c0");
	const now = await resolveScript(client, script.id);
	if (!now.isActive) throw new JmapError("The server accepted the request but the script is not active.");
	return { id: now.id, name: now.name, isActive: true, replacedActiveScript: previouslyActive?.name ?? null };
}

export async function deactivateScript(client: JmapClient) {
	const accountId = await client.accountId(SIEVE);
	const before = (await listScripts(client)).find((s) => s.isActive);
	const responses = await client.call(USING, [
		["SieveScript/set", { accountId, onSuccessDeactivateScript: true }],
	]);
	responseFor(responses, "c0");
	return { deactivated: before?.name ?? null };
}

export async function renameScript(client: JmapClient, ref: string, newName: string) {
	const script = await resolveScript(client, ref);
	const accountId = await client.accountId(SIEVE);
	const responses = await client.call(USING, [
		["SieveScript/set", { accountId, update: { [script.id]: { name: newName } } }],
	]);
	throwSetError(
		"rename the script",
		(responseFor(responses, "c0").notUpdated as Record<string, SetError> | undefined)?.[script.id],
	);
	return { id: script.id, oldName: script.name, name: newName, isActive: script.isActive };
}

export async function deleteScript(
	client: JmapClient,
	ref: string,
	deactivateIfActive: boolean,
) {
	const script = await resolveScript(client, ref);
	if (script.isActive && !deactivateIfActive) {
		throw new PolicyError(
			`"${script.name}" is the active script. Deleting it turns off all filtering. Retry with deactivate_if_active: true if the user agrees.`,
		);
	}
	const previousContent = await readScript(client, script);
	const accountId = await client.accountId(SIEVE);
	// RFC 9661: an active script can only be destroyed after a separate
	// SieveScript/set call has deactivated it; both go in one request.
	const calls: Parameters<JmapClient["call"]>[1] = script.isActive
		? [
				["SieveScript/set", { accountId, onSuccessDeactivateScript: true }],
				["SieveScript/set", { accountId, destroy: [script.id] }],
			]
		: [["SieveScript/set", { accountId, destroy: [script.id] }]];
	const responses = await client.call(USING, calls);
	const last = responseFor(responses, `c${calls.length - 1}`);
	throwSetError("delete the script", (last.notDestroyed as Record<string, SetError> | undefined)?.[script.id]);
	return { deleted: script.name, wasActive: script.isActive, previousContent };
}

export async function getCapabilities(client: JmapClient, policy: Policy) {
	const session = await client.session();
	const accountId = await client.accountId(SIEVE);
	const account = session.accounts[accountId]?.accountCapabilities?.[SIEVE];
	if (!account) throw new JmapError("This JMAP account does not advertise Sieve support.");
	return {
		implementation: (session.capabilities[SIEVE] as { implementation?: string } | undefined)?.implementation ?? null,
		account,
		serverPolicy: { deniedSieveActions: policy.deniedActions, readOnly: policy.readOnly },
	};
}

// ---- vacation responder -------------------------------------------------

export interface VacationUpdate {
	isEnabled?: boolean;
	fromDate?: string | null;
	toDate?: string | null;
	subject?: string | null;
	textBody?: string | null;
	htmlBody?: string | null;
}

const VACATION_USING = [CORE, VACATION];

export async function getVacation(client: JmapClient) {
	const accountId = await client.accountId(VACATION);
	const responses = await client.call(VACATION_USING, [["VacationResponse/get", { accountId, ids: null }]]);
	const list = responseFor(responses, "c0").list as Array<Record<string, unknown>> | undefined;
	return list?.[0] ?? null;
}

export async function setVacation(client: JmapClient, update: VacationUpdate) {
	const accountId = await client.accountId(VACATION);
	const current = (await getVacation(client)) as { id?: string } | null;
	const id = current?.id ?? "singleton";
	const responses = await client.call(VACATION_USING, [
		["VacationResponse/set", { accountId, update: { [id]: update } }],
	]);
	throwSetError(
		"update the vacation response",
		(responseFor(responses, "c0").notUpdated as Record<string, SetError> | undefined)?.[id],
	);
	return getVacation(client);
}

// ---- quota ---------------------------------------------------------------

export async function getQuota(client: JmapClient) {
	const accountId = await client.accountId(QUOTA);
	const responses = await client.call([CORE, QUOTA], [["Quota/get", { accountId, ids: null }]]);
	return (responseFor(responses, "c0").list as unknown[] | undefined) ?? [];
}
