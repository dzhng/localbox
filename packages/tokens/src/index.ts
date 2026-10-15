import { createHash, createPrivateKey, createPublicKey, createSign, type KeyObject } from "node:crypto";

type JwtClaims = Record<string, string | number | string[]>;
const encoder = new TextEncoder();
const base64url = (value: Uint8Array | string): string => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
};
const privateKey = () => {
  const raw = process.env.LOCALBOX_JWT_PRIVATE_KEY;
  if (!raw) throw new Error("LOCALBOX_JWT_PRIVATE_KEY is required");
  return createPrivateKey(raw.replaceAll("\\n", "\n"));
};
/** RFC 7638 thumbprint of the EC public key: the `kid` Convex uses to pick the verification key. */
function keyId(key: KeyObject): string {
  const { crv, kty, x, y } = createPublicKey(key).export({ format: "jwk" });
  return createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
}

/** The JWKS document Convex verifies against (`LOCALBOX_JWKS`), derived from the signing key. */
export function publicJwks(privatePem = process.env.LOCALBOX_JWT_PRIVATE_KEY ?? ""): string {
  const key = createPrivateKey(privatePem.replaceAll("\\n", "\n"));
  return JSON.stringify({ keys: [{ ...createPublicKey(key).export({ format: "jwk" }), alg: "ES256", use: "sig", kid: keyId(key) }] });
}

const sign = (claims: JwtClaims): string => {
  const key = privateKey();
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keyId(key) }));
  const payload = base64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const times = () => Math.floor(Date.now() / 1000);

export function signServiceToken(): string {
  const now = times();
  return sign({ iss: process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000", aud: "localbox-convex", sub: "service:api", iat: now, exp: now + 300 });
}

export function signMachineToken(machineId: string, accountId: string): string {
  const now = times();
  return sign({ iss: process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000", aud: "localbox-convex", sub: `machine:${machineId}`, account: accountId, iat: now, exp: now + 86_400 });
}

/** Convex identity for an MCP agent's OAuth token family; Convex re-checks the family's revocation on every call. */
export function signAgentToken(familyId: string, accountId: string): string {
  const now = times();
  return sign({ iss: process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000", aud: "localbox-convex", sub: `agent:${familyId}`, account: accountId, iat: now, exp: now + 300 });
}
