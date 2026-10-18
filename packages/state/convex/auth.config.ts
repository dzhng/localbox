import type { AuthConfig } from "convex/server";

// The same default as `DEFAULT_API_ORIGIN` in packages/config (Convex bundles this file alone, so it is not imported).
const issuer = process.env.LOCALBOX_API_ORIGIN ?? "https://api.localbox.sh";
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
