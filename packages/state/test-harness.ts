import { convexTest, type TestConvexForDataModelAndIdentity } from "convex-test";
import schema from "./convex/schema.js";

/** In-process Convex deployment exercising the production schema and modules. */
export function createConvexTestHarness() {
  return convexTest(schema, {
    "./_generated/api.ts": async () => ({}),
    "./owners.ts": async () => import("./convex/owners.js"),
    "./vms.ts": async () => import("./convex/vms.js"),
    "./relay.ts": async () => import("./convex/relay.js"),
    "./authCodes.ts": async () => import("./convex/authCodes.js"),
    "./oauth.ts": async () => import("./convex/oauth.js"),
    "./audit.ts": async () => import("./convex/audit.js"),
    "./quotas.ts": async () => import("./convex/quotas.js"),
    "./snapshots.ts": async () => import("./convex/snapshots.js"),
    "./admin.ts": async () => import("./convex/admin.js"),
    "./machines.ts": async () => import("./convex/machines.js"),
    "./signin.ts": async () => import("./convex/signin.js"),
    "./accounts.ts": async () => import("./convex/accounts.js"),
  }) as TestConvexForDataModelAndIdentity<any>;
}
