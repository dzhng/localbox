// Empties every Convex table through the deploy key (`npx convex run`), the only route to the
// internal `admin:wipe` mutation. Production needs LOCALBOX_ALLOW_PROD_WIPE=1 as well (map Q14).
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const target = args[0] === "--deployment" ? args[1] : args[0];
if (target !== "local" && target !== "prod") throw new Error("usage: convex-wipe.ts --deployment local|prod");
if (target === "prod" && process.env.LOCALBOX_ALLOW_PROD_WIPE !== "1") throw new Error("production wipe requires LOCALBOX_ALLOW_PROD_WIPE=1");
execFileSync("npx", ["convex", "run", ...(target === "prod" ? ["--prod"] : []), "admin:wipe"], { stdio: "inherit" });
console.log(`wiped Convex ${target} deployment`);
