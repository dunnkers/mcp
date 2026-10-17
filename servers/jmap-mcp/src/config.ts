import { ConfigError } from "./errors.js";

/**
 * Everything provider-specific lives in Worker secrets/vars, never in the repo:
 * JMAP_SESSION_URL (e.g. the server's /.well-known/jmap), JMAP_USERNAME and
 * JMAP_PASSWORD (an app password; HTTP Basic).
 */
export interface JmapConfig {
	sessionUrl: URL;
	username: string;
	password: string;
}

export interface Policy {
	/** Lower-case Sieve action/extension names a script may not use. */
	deniedActions: string[];
	/** When true, only read-only tools are registered. */
	readOnly: boolean;
}

export interface ConfigEnv {
	JMAP_SESSION_URL?: string;
	JMAP_USERNAME?: string;
	JMAP_PASSWORD?: string;
	DENY_SIEVE_ACTIONS?: string;
	READ_ONLY?: string;
}

/**
 * Sieve actions that can send mail content somewhere else. `redirect`
 * forwards a copy of every matching message; `notify` (RFC 5435 enotify) can
 * mail out message text. Denied unless the operator opts out.
 */
export const DEFAULT_DENIED_ACTIONS = ["redirect", "notify"];

export function loadJmapConfig(env: ConfigEnv): JmapConfig {
	const { JMAP_SESSION_URL, JMAP_USERNAME, JMAP_PASSWORD } = env;
	if (!JMAP_SESSION_URL || !JMAP_USERNAME || !JMAP_PASSWORD) {
		throw new ConfigError(
			"The JMAP backend is not configured: set the JMAP_SESSION_URL, JMAP_USERNAME and JMAP_PASSWORD secrets on the Worker.",
		);
	}
	let sessionUrl: URL;
	try {
		sessionUrl = new URL(JMAP_SESSION_URL);
	} catch {
		throw new ConfigError("JMAP_SESSION_URL is not a valid URL.");
	}
	if (sessionUrl.protocol !== "https:") {
		throw new ConfigError("JMAP_SESSION_URL must be an https:// URL.");
	}
	return { sessionUrl, username: JMAP_USERNAME, password: JMAP_PASSWORD };
}

export function loadPolicy(env: ConfigEnv): Policy {
	const raw = env.DENY_SIEVE_ACTIONS;
	const deniedActions =
		raw === undefined
			? DEFAULT_DENIED_ACTIONS
			: raw
					.split(",")
					.map((entry) => entry.trim().toLowerCase())
					.filter((entry) => entry !== "" && entry !== "none");
	const readOnly = ["1", "true", "yes"].includes((env.READ_ONLY ?? "").trim().toLowerCase());
	return { deniedActions, readOnly };
}
