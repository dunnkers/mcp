import type { Env } from "./env.js";

// Workload identity federation without a built-in identity provider: the
// Worker is its own OIDC issuer. It signs a short-lived JWT with a private key
// held as a secret and publishes the public key at /.well-known/jwks.json
// (plus discovery metadata). Google STS verifies that token against the
// workload identity pool's OIDC provider and returns a federated access token,
// which is optionally exchanged for a service account's access token.
const STS_URL = "https://sts.googleapis.com/v1/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const OIDC_TOKEN_TTL_SECONDS = 300;
// Refresh this long before Google says the access token expires.
const EXPIRY_SKEW_MS = 60_000;

interface PrivateJwk extends JsonWebKey {
	kid?: string;
}

function parsePrivateJwk(env: Env): PrivateJwk {
	let jwk: PrivateJwk;
	try {
		jwk = JSON.parse(env.OIDC_PRIVATE_KEY_JWK) as PrivateJwk;
	} catch {
		throw new Error("OIDC_PRIVATE_KEY_JWK is unset or not valid JSON (run `npm run gen:oidc-key`)");
	}
	if (jwk.kty !== "RSA" || !jwk.d || !jwk.n || !jwk.e) {
		throw new Error("OIDC_PRIVATE_KEY_JWK must be an RSA private key in JWK format");
	}
	return jwk;
}

export function issuerFor(request: Request, env: Env): string {
	return (env.OIDC_ISSUER ?? new URL(request.url).origin).replace(/\/$/, "");
}

/** The public half of the signing key, for /.well-known/jwks.json. */
export function publicJwks(env: Env): { keys: JsonWebKey[] } {
	const { n, e, kid } = parsePrivateJwk(env);
	return { keys: [{ kty: "RSA", n, e, kid, alg: "RS256", use: "sig" } as JsonWebKey] };
}

export function discoveryDocument(issuer: string): Record<string, unknown> {
	return {
		issuer,
		jwks_uri: `${issuer}/.well-known/jwks.json`,
		response_types_supported: ["id_token"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
	};
}

function b64url(data: ArrayBuffer | string): string {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintOidcToken(env: Env, issuer: string, now = Date.now()): Promise<string> {
	const jwk = parsePrivateJwk(env);
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const iat = Math.floor(now / 1000);
	const header = { alg: "RS256", typ: "JWT", kid: jwk.kid };
	const claims = {
		iss: issuer,
		sub: env.OIDC_SUBJECT ?? "voice-memo-summarizer-worker",
		aud: env.WIF_AUDIENCE,
		iat,
		exp: iat + OIDC_TOKEN_TTL_SECONDS,
	};
	const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${b64url(signature)}`;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${new URL(url).host} responded ${response.status}: ${text.slice(0, 500)}`);
	}
	return JSON.parse(text) as T;
}

async function exchange(env: Env, issuer: string): Promise<{ token: string; expiresAt: number }> {
	const subjectToken = await mintOidcToken(env, issuer);
	const sts = await postJson<{ access_token: string; expires_in?: number }>(STS_URL, {
		grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
		audience: env.WIF_AUDIENCE,
		scope: SCOPE,
		requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
		subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
		subjectToken,
	});
	if (!env.SERVICE_ACCOUNT_EMAIL) {
		return { token: sts.access_token, expiresAt: Date.now() + (sts.expires_in ?? 3600) * 1000 };
	}
	const sa = await postJson<{ accessToken: string; expireTime: string }>(
		`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.SERVICE_ACCOUNT_EMAIL)}:generateAccessToken`,
		{ scope: [SCOPE] },
		{ authorization: `Bearer ${sts.access_token}` },
	);
	return { token: sa.accessToken, expiresAt: Date.parse(sa.expireTime) };
}

// Access tokens last about an hour; reuse them across requests handled by the
// same isolate instead of doing two Google round trips every time.
let cached: { token: string; expiresAt: number; key: string } | undefined;

export async function getAccessToken(env: Env, issuer: string): Promise<string> {
	const key = [issuer, env.WIF_AUDIENCE, env.SERVICE_ACCOUNT_EMAIL ?? ""].join("|");
	if (cached && cached.key === key && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
		return cached.token;
	}
	const fresh = await exchange(env, issuer);
	cached = { ...fresh, key };
	return fresh.token;
}

export function resetTokenCache(): void {
	cached = undefined;
}
