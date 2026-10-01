// Generates the RSA key the Worker signs its OIDC tokens with and prints the
// private key as one-line JWK JSON on stdout, ready to pipe into
//   npx wrangler secret put OIDC_PRIVATE_KEY_JWK
import { createHash, generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = privateKey.export({ format: "jwk" });
// RFC 7638 thumbprint as the key id.
const thumbprint = createHash("sha256")
	.update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
	.digest("base64url");
process.stdout.write(JSON.stringify({ ...jwk, kid: thumbprint, alg: "RS256", use: "sig" }));
