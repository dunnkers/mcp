/// <reference types="@cloudflare/workers-types" />

export interface Env {
	RATE_LIMITER: RateLimit;
	/** Shared secret callers send as `Authorization: Bearer <token>`. */
	AUTH_TOKEN: string;
	/** Private RSA key (JWK JSON) the Worker signs its OIDC tokens with. */
	OIDC_PRIVATE_KEY_JWK: string;
	/**
	 * `//iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`
	 */
	WIF_AUDIENCE: string;
	/** Must match the provider's issuer URI. Defaults to the request's origin. */
	OIDC_ISSUER?: string;
	/** `sub` claim of the Worker's OIDC token. */
	OIDC_SUBJECT?: string;
	/** If set, the federated token is exchanged for this service account's token. */
	SERVICE_ACCOUNT_EMAIL?: string;
	GCP_PROJECT_ID: string;
	GCS_BUCKET: string;
	/** `global` or a region such as `europe-west4`. */
	VERTEX_LOCATION: string;
	GEMINI_MODEL: string;
}
