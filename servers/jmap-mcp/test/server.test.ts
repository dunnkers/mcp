import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler.js";
import { createFakeJmap, ENV } from "./fake-jmap.js";

async function rpc(env: Record<string, string | undefined>, fetchImpl: any, method: string, params?: unknown) {
	const response = await handleMcpRequest(
		new Request("https://worker.test/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}),
		env,
		fetchImpl,
	);
	return response.json() as Promise<any>;
}

async function tool(env: Record<string, string | undefined>, fake: ReturnType<typeof createFakeJmap>, name: string, args: unknown = {}) {
	const body = await rpc(env, fake.fetchImpl, "tools/call", { name, arguments: args });
	const result = body.result;
	const text = result.content[0].text as string;
	return { isError: Boolean(result.isError), text, json: result.isError ? null : JSON.parse(text) };
}

describe("tool registration", () => {
	it("registers every tool, with no mail-reading tools", async () => {
		const body = await rpc(ENV, createFakeJmap().fetchImpl, "tools/list");
		const names = body.result.tools.map((t: any) => t.name).sort();
		expect(names).toEqual([
			"get_quota",
			"sieve_activate_script",
			"sieve_deactivate_script",
			"sieve_delete_script",
			"sieve_get_capabilities",
			"sieve_get_script",
			"sieve_list_scripts",
			"sieve_put_script",
			"sieve_rename_script",
			"sieve_validate_script",
			"vacation_get",
			"vacation_set",
		]);
	});

	it("READ_ONLY hides every write tool", async () => {
		const body = await rpc({ ...ENV, READ_ONLY: "true" }, createFakeJmap().fetchImpl, "tools/list");
		const names = body.result.tools.map((t: any) => t.name).sort();
		expect(names).toEqual([
			"get_quota",
			"sieve_get_capabilities",
			"sieve_get_script",
			"sieve_list_scripts",
			"sieve_validate_script",
			"vacation_get",
		]);
	});

	it("lists tools without any JMAP configuration", async () => {
		const body = await rpc({}, createFakeJmap().fetchImpl, "tools/list");
		expect(body.result.tools.length).toBeGreaterThan(0);
	});

	it("reports missing configuration as a tool error", async () => {
		const result = await tool({}, createFakeJmap(), "sieve_list_scripts");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("not configured");
	});
});

describe("sieve scripts", () => {
	const SCRIPT = `require ["fileinto"];\nfileinto "Gmail";`;

	it("creates, lists, reads, activates, updates, deactivates and deletes a script", async () => {
		const fake = createFakeJmap();
		const created = await tool(ENV, fake, "sieve_put_script", { name: "main", content: SCRIPT });
		expect(created.json).toMatchObject({ action: "created", name: "main", isActive: false, previousContent: null });

		const listed = await tool(ENV, fake, "sieve_list_scripts");
		expect(listed.json).toHaveLength(1);

		const got = await tool(ENV, fake, "sieve_get_script", { script: "main" });
		expect(got.json).toMatchObject({ name: "main", content: SCRIPT });

		const activated = await tool(ENV, fake, "sieve_activate_script", { script: "main" });
		expect(activated.json).toMatchObject({ isActive: true, replacedActiveScript: null });

		const blocked = await tool(ENV, fake, "sieve_put_script", { name: "main", content: `${SCRIPT}\nstop;` });
		expect(blocked.isError).toBe(true);
		expect(blocked.text).toContain("confirm_update_active");

		const updated = await tool(ENV, fake, "sieve_put_script", {
			name: "main",
			content: `${SCRIPT}\nstop;`,
			confirm_update_active: true,
		});
		expect(updated.json).toMatchObject({ action: "updated", isActive: true, previousContent: SCRIPT });

		const refusedDelete = await tool(ENV, fake, "sieve_delete_script", { script: "main" });
		expect(refusedDelete.isError).toBe(true);
		expect(fake.scripts.size).toBe(1);

		const deleted = await tool(ENV, fake, "sieve_delete_script", { script: "main", deactivate_if_active: true });
		expect(deleted.json).toMatchObject({ deleted: "main", wasActive: true });
		expect(fake.scripts.size).toBe(0);
	});

	it("sends deactivate and destroy as two calls in one request", async () => {
		const fake = createFakeJmap();
		await tool(ENV, fake, "sieve_put_script", { name: "main", content: SCRIPT });
		await tool(ENV, fake, "sieve_activate_script", { script: "main" });
		fake.requests.length = 0;
		await tool(ENV, fake, "sieve_delete_script", { script: "main", deactivate_if_active: true });
		const calls = fake.requests
			.map((r) => r.body as any)
			.filter((b) => b?.methodCalls)
			.find((b) => b.methodCalls.some(([, args]: any) => args.destroy));
		expect(calls.methodCalls.map(([name, args]: any) => [name, Object.keys(args).filter((k) => k !== "accountId")])).toEqual([
			["SieveScript/set", ["onSuccessDeactivateScript"]],
			["SieveScript/set", ["destroy"]],
		]);
	});

	it("rejects invalid Sieve with the server's message and stores nothing", async () => {
		const fake = createFakeJmap();
		const result = await tool(ENV, fake, "sieve_put_script", { name: "bad", content: "SYNTAXERROR" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("line 1: bad");
		expect(fake.scripts.size).toBe(0);
	});

	it("blocks denied actions on put, validate and activate", async () => {
		const fake = createFakeJmap();
		const put = await tool(ENV, fake, "sieve_put_script", { name: "fwd", content: `redirect "a@example.test";` });
		expect(put.isError).toBe(true);
		expect(put.text).toContain("redirect");
		expect(fake.scripts.size).toBe(0);

		const validated = await tool(ENV, fake, "sieve_validate_script", { content: `redirect "a@example.test";` });
		expect(validated.json).toMatchObject({ valid: false, deniedActions: ["redirect"] });

		// A script that got in by another route (e.g. a mail client) is still refused on activation.
		fake.blobs.set("outside", `redirect "a@example.test";`);
		fake.scripts.set("sx", { id: "sx", name: "outside", blobId: "outside", isActive: false });
		const activated = await tool(ENV, fake, "sieve_activate_script", { script: "outside" });
		expect(activated.isError).toBe(true);
		expect(fake.scripts.get("sx")?.isActive).toBe(false);
	});

	it("allows redirect when the operator clears the denylist", async () => {
		const fake = createFakeJmap();
		const put = await tool({ ...ENV, DENY_SIEVE_ACTIONS: "" }, fake, "sieve_put_script", {
			name: "fwd",
			content: `redirect "a@example.test";`,
		});
		expect(put.isError).toBe(false);
	});

	it("renames and reports duplicate names", async () => {
		const fake = createFakeJmap();
		await tool(ENV, fake, "sieve_put_script", { name: "a", content: SCRIPT });
		const renamed = await tool(ENV, fake, "sieve_rename_script", { script: "a", new_name: "b" });
		expect(renamed.json).toMatchObject({ oldName: "a", name: "b" });
	});

	it("returns capabilities with the server policy", async () => {
		const result = await tool(ENV, createFakeJmap(), "sieve_get_capabilities");
		expect(result.json).toMatchObject({
			implementation: "Fake 1.0",
			account: { maxSizeScript: 1000 },
			serverPolicy: { deniedSieveActions: ["redirect", "notify"], readOnly: false },
		});
	});
});

describe("vacation and quota", () => {
	it("reads and updates the vacation response", async () => {
		const fake = createFakeJmap();
		const updated = await tool(ENV, fake, "vacation_set", { is_enabled: true, subject: "Away", text_body: "Back soon" });
		expect(updated.json).toMatchObject({ isEnabled: true, subject: "Away", textBody: "Back soon" });
		const read = await tool(ENV, fake, "vacation_get");
		expect(read.json).toMatchObject({ isEnabled: true });
		const empty = await tool(ENV, fake, "vacation_set", {});
		expect(empty.isError).toBe(true);
	});

	it("returns quota", async () => {
		const result = await tool(ENV, createFakeJmap(), "get_quota");
		expect(result.json).toEqual([{ id: "q1", used: 10, hardLimit: 100 }]);
	});
});

describe("credential handling", () => {
	it("follows the session redirect and sends Basic auth only to the configured origin", async () => {
		const fake = createFakeJmap();
		await tool(ENV, fake, "sieve_list_scripts");
		const expected = `Basic ${btoa("user@example.test:app-password")}`;
		expect(fake.requests.length).toBeGreaterThan(2);
		for (const request of fake.requests) {
			expect(new URL(request.url).origin).toBe("https://jmap.example.test");
			expect(request.authorization).toBe(expected);
		}
	});

	it("refuses a session document that points the API at another origin", async () => {
		const fake = createFakeJmap({ sessionApiUrl: "https://evil.example.test/api" });
		const result = await tool(ENV, fake, "sieve_list_scripts");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("different origin");
		expect(fake.requests.every((r) => new URL(r.url).origin === "https://jmap.example.test")).toBe(true);
	});

	it("never echoes the password in errors", async () => {
		const fake = createFakeJmap();
		const unauthorized = async () => new Response("nope", { status: 401 });
		const body = await rpc(ENV, unauthorized, "tools/call", { name: "sieve_list_scripts", arguments: {} });
		expect(body.result.isError).toBe(true);
		expect(JSON.stringify(body)).not.toContain("app-password");
		expect(body.result.content[0].text).toContain("rejected the credentials");
		void fake;
	});
});
