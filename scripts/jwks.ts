// Prints the JWKS Convex verifies Localbox tokens with, derived from LOCALBOX_JWT_PRIVATE_KEY:
//   npx convex env set LOCALBOX_JWKS "$(npx tsx scripts/jwks.ts)"
import { publicJwks } from "../packages/tokens/src/index.js";

process.stdout.write(`${publicJwks()}\n`);
