// A tiny in-memory JMAP server (session, upload, download, SieveScript/*,
// VacationResponse/*, Quota/get) behind a fetch-shaped function, so tests
// never touch a real account.
export const ORIGIN = "https://jmap.example.test";
export const SESSION_URL = `${ORIGIN}/.well-known/jmap`;
export const ENV = {
	JMAP_SESSION_URL: SESSION_URL,
	JMAP_USERNAME: "user@example.test",
	JMAP_PASSWORD: "app-password",
};

interface Script {
	id: string;
	name: string;
	blobId: string;
	isActive: boolean;
}

export function createFakeJmap(options: { sessionApiUrl?: string } = {}) {
	const blobs = new Map<string, string>();
	const scripts = new Map<string, Script>();
	const requests: Array<{ url: string; authorization: string | null; body?: unknown }> = [];
	let nextId = 1;
	let vacation: Record<string, unknown> = { id: "singleton", isEnabled: false, subject: null, textBody: null };

	const session = {
		capabilities: { "urn:ietf:params:jmap:sieve": { implementation: "Fake 1.0" } },
		accounts: {
			acc1: {
				name: "user@example.test",
				isPersonal: true,
				accountCapabilities: {
					"urn:ietf:params:jmap:sieve": { maxSizeScript: 1000, sieveExtensions: ["fileinto", "vacation"] },
				},
			},
		},
		primaryAccounts: { "urn:ietf:params:jmap:sieve": "acc1" },
		apiUrl: options.sessionApiUrl ?? `${ORIGIN}/jmap/api`,
		uploadUrl: `${ORIGIN}/jmap/upload/{accountId}/`,
		downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
	};

	function method(name: string, args: Record<string, any>): [string, Record<string, unknown>] {
		switch (name) {
			case "SieveScript/get":
				return [name, { list: [...scripts.values()] }];
			case "SieveScript/validate": {
				const text = blobs.get(args.blobId) ?? "";
				return [name, { error: text.includes("SYNTAXERROR") ? { type: "invalidSieve", description: "line 1: bad" } : null }];
			}
			case "SieveScript/set": {
				const result: Record<string, any> = { created: {}, notCreated: {}, notUpdated: {}, notDestroyed: {} };
				for (const [key, value] of Object.entries<any>(args.create ?? {})) {
					if ([...scripts.values()].some((s) => s.name === value.name)) {
						result.notCreated[key] = { type: "alreadyExists" };
						continue;
					}
					const id = `s${nextId++}`;
					scripts.set(id, { id, name: value.name, blobId: value.blobId, isActive: false });
					result.created[key] = { id };
				}
				for (const [id, patch] of Object.entries<any>(args.update ?? {})) {
					const script = scripts.get(id);
					if (!script) result.notUpdated[id] = { type: "notFound" };
					else Object.assign(script, patch);
				}
				for (const id of args.destroy ?? []) {
					if (scripts.get(id)?.isActive) result.notDestroyed[id] = { type: "sieveIsActive" };
					else scripts.delete(id);
				}
				if (args.onSuccessDeactivateScript) for (const s of scripts.values()) s.isActive = false;
				if (args.onSuccessActivateScript && scripts.has(args.onSuccessActivateScript)) {
					for (const s of scripts.values()) s.isActive = s.id === args.onSuccessActivateScript;
				}
				return [name, result];
			}
			case "VacationResponse/get":
				return [name, { list: [vacation] }];
			case "VacationResponse/set":
				Object.assign(vacation, args.update.singleton);
				return [name, { updated: { singleton: null } }];
			case "Quota/get":
				return [name, { list: [{ id: "q1", used: 10, hardLimit: 100 }] }];
			default:
				return ["error", { type: "unknownMethod" }];
		}
	}

	const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
		const headers = init.headers as Record<string, string>;
		const body = typeof init.body === "string" ? init.body : undefined;
		requests.push({ url: input, authorization: headers?.Authorization ?? null, body: body && init.method === "POST" && input.includes("/api") ? JSON.parse(body) : body });
		const url = new URL(input);
		if (url.pathname === "/.well-known/jmap") {
			return new Response(null, { status: 307, headers: { Location: "/jmap/session" } });
		}
		if (url.pathname === "/jmap/session") return Response.json(session);
		if (url.pathname.startsWith("/jmap/upload/")) {
			const blobId = `b${blobs.size + 1}`;
			blobs.set(blobId, body ?? "");
			return Response.json({ blobId });
		}
		if (url.pathname.startsWith("/jmap/download/")) {
			const blobId = url.pathname.split("/")[4] as string;
			return new Response(blobs.get(blobId) ?? "", { status: blobs.has(blobId) ? 200 : 404 });
		}
		if (url.pathname === "/jmap/api") {
			const request = JSON.parse(body ?? "{}");
			const methodResponses = request.methodCalls.map(([name, args, id]: [string, any, string]) => [...method(name, args), id]);
			return Response.json({ methodResponses });
		}
		return new Response("not found", { status: 404 });
	};

	return { fetchImpl, requests, scripts, blobs };
}
