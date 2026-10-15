import type { AuthConfig } from "convex/server";

const issuer = process.env.LOCALBOX_API_ORIGIN ?? "http://127.0.0.1:3000";
const jwks = process.env.LOCALBOX_JWKS ?? "{}";

export default {
  providers: [{
    type: "customJwt",
    algorithm: "ES256",
    issuer,
    applicationID: "localbox-convex",
    jwks: `data:application/json,${encodeURIComponent(jwks)}`,
  }],
} satisfies AuthConfig;
