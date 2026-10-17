import type { JmapConfig } from "./config.js";
import { JmapError } from "./errors.js";

export const CORE = "urn:ietf:params:jmap:core";
export const SIEVE = "urn:ietf:params:jmap:sieve";
export const VACATION = "urn:ietf:params:jmap:vacationresponse";
export const QUOTA = "urn:ietf:params:jmap:quota";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface JmapSession {
	capabilities: Record<string, unknown>;
	accounts: Record<
		string,
		{ name?: string; isPersonal?: boolean; accountCapabilities?: Record<string, unknown> }
	>;
	primaryAccounts: Record<string, string>;
	apiUrl: string;
	downloadUrl: string;
	uploadUrl: string;
}

export type MethodCall = [name: string, args: Record<string, unknown>];
type MethodResponse = [name: string, args: Record<string, unknown>, callId: string];

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function basicAuth(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/**
 * Minimal JMAP (RFC 8620) client over fetch with HTTP Basic auth.
 *
 * The credential is only ever sent to the origin of the configured session
 * URL: redirects and the apiUrl/uploadUrl/downloadUrl advertised by the
 * session document must stay on that origin, or the request is refused. That
 * stops a compromised or misconfigured session document from collecting the
 * password.
 */
export class JmapClient {
	private sessionPromise: Promise<JmapSession> | null = null;
	private readonly origin: string;
	private readonly authorization: string;

	constructor(
		private readonly config: JmapConfig,
		private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
	) {
		this.origin = config.sessionUrl.origin;
		this.authorization = basicAuth(config.username, config.password);
	}

	private async send(url: string, init: RequestInit): Promise<Response> {
		if (new URL(url).origin !== this.origin) {
			throw new JmapError("Refusing to send credentials to a different origin than JMAP_SESSION_URL.");
		}
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				...init,
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: { ...(init.headers as Record<string, string>), Authorization: this.authorization },
			});
		} catch {
			throw new JmapError("Could not reach the JMAP server.");
		}
		if (response.status === 401 || response.status === 403) {
			throw new JmapError(
				"The JMAP server rejected the credentials (check JMAP_USERNAME / JMAP_PASSWORD and the app password's permissions).",
			);
		}
		return response;
	}

	session(): Promise<JmapSession> {
		this.sessionPromise ??= this.fetchSession().catch((error) => {
			this.sessionPromise = null;
			throw error;
		});
		return this.sessionPromise;
	}

	private async fetchSession(): Promise<JmapSession> {
		let url = this.config.sessionUrl.toString();
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const response = await this.send(url, { headers: { Accept: "application/json" } });
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("Location");
				if (!location) throw new JmapError("The JMAP server sent a redirect without a Location.");
				url = new URL(location, url).toString();
				continue;
			}
			if (!response.ok) {
				throw new JmapError(`Fetching the JMAP session failed (HTTP ${response.status}).`);
			}
			const session = (await response.json().catch(() => null)) as JmapSession | null;
			if (!session?.apiUrl || !session.uploadUrl || !session.downloadUrl || !session.accounts) {
				throw new JmapError("The JMAP session document is missing required fields.");
			}
			for (const advertised of [session.apiUrl, session.uploadUrl, session.downloadUrl]) {
				if (new URL(advertised).origin !== this.origin) {
					throw new JmapError(
						"The JMAP session advertises an endpoint on a different origin; refusing to use it.",
					);
				}
			}
			return session;
		}
		throw new JmapError("Too many redirects while fetching the JMAP session.");
	}

	/** The account to use for a capability: its primary account, else the personal one. */
	async accountId(capability: string): Promise<string> {
		const session = await this.session();
		const primary = session.primaryAccounts?.[capability];
		if (primary) return primary;
		const personal = Object.entries(session.accounts).find(([, account]) => account.isPersonal);
		if (!personal) throw new JmapError("No personal JMAP account found in the session.");
		return personal[0];
	}

	/** Run method calls in one request and return responses keyed by call id (`c0`, `c1`, ...). */
	async call(using: string[], calls: MethodCall[]): Promise<Map<string, [string, Record<string, unknown>]>> {
		const session = await this.session();
		const response = await this.send(session.apiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				using,
				methodCalls: calls.map(([name, args], index) => [name, args, `c${index}`]),
			}),
		});
		if (!response.ok) {
			const problem = (await response.json().catch(() => null)) as {
				type?: string;
				detail?: string;
			} | null;
			throw new JmapError(
				`JMAP request failed (HTTP ${response.status}${problem?.type ? `, ${problem.type}` : ""}${problem?.detail ? `: ${problem.detail}` : ""}).`,
				problem?.type,
			);
		}
		const body = (await response.json().catch(() => null)) as {
			methodResponses?: MethodResponse[];
		} | null;
		if (!body?.methodResponses) throw new JmapError("The JMAP server returned an unreadable response.");
		const byId = new Map<string, [string, Record<string, unknown>]>();
		for (const [name, args, id] of body.methodResponses) {
			if (name === "error") {
				const type = String(args.type ?? "serverFail");
				const description = args.description ? `: ${String(args.description)}` : "";
				throw new JmapError(`JMAP error ${type}${description}`, type);
			}
			byId.set(id, [name, args]);
		}
		return byId;
	}

	/** Upload text and return its blob id. */
	async upload(content: string, contentType: string): Promise<string> {
		const session = await this.session();
		const accountId = await this.accountId(SIEVE);
		const response = await this.send(session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)), {
			method: "POST",
			headers: { "Content-Type": contentType, Accept: "application/json" },
			body: content,
		});
		if (!response.ok) throw new JmapError(`Upload failed (HTTP ${response.status}).`);
		const result = (await response.json().catch(() => null)) as { blobId?: string } | null;
		if (!result?.blobId) throw new JmapError("The upload response had no blobId.");
		return result.blobId;
	}

	/** Download a blob as text. */
	async download(blobId: string, name: string, contentType: string): Promise<string> {
		const session = await this.session();
		const accountId = await this.accountId(SIEVE);
		const url = session.downloadUrl
			.replace("{accountId}", encodeURIComponent(accountId))
			.replace("{blobId}", encodeURIComponent(blobId))
			.replace("{name}", encodeURIComponent(name))
			.replace("{type}", encodeURIComponent(contentType));
		const response = await this.send(url, { headers: { Accept: contentType } });
		if (!response.ok) throw new JmapError(`Download failed (HTTP ${response.status}).`);
		return response.text();
	}
}

/** Pull the `[name, args]` for a call id, failing clearly if the server skipped it. */
export function responseFor(
	responses: Map<string, [string, Record<string, unknown>]>,
	callId: string,
): Record<string, unknown> {
	const entry = responses.get(callId);
	if (!entry) throw new JmapError(`The JMAP server did not answer call ${callId}.`);
	return entry[1];
}

export interface SetError {
	type?: string;
	description?: string;
	existingId?: string;
	properties?: string[];
}

/** Throw a readable error for an entry in `notCreated` / `notUpdated` / `notDestroyed`. */
export function throwSetError(action: string, error: SetError | undefined): void {
	if (!error) return;
	const detail = error.description ? `: ${error.description}` : "";
	const hint =
		error.type === "alreadyExists" && error.existingId ? ` (existing id ${error.existingId})` : "";
	throw new JmapError(`Could not ${action}: ${error.type ?? "unknown error"}${detail}${hint}`, error.type);
}
