import { convexTest, type TestConvexForDataModelAndIdentity } from "convex-test";
import schema from "./convex/schema.js";

/** In-process Convex deployment exercising the production schema and modules. */
export function createConvexTestHarness() {
  return convexTest(schema, {
    "./_generated/api.ts": async () => ({}),
    "./relay.ts": async () => import("./convex/relay.js"),
    "./oauth.ts": async () => import("./convex/oauth.js"),
    "./snapshots.ts": async () => import("./convex/snapshots.js"),
    "./admin.ts": async () => import("./convex/admin.js"),
    "./machines.ts": async () => import("./convex/machines.js"),
    "./signin.ts": async () => import("./convex/signin.js"),
    "./accounts.ts": async () => import("./convex/accounts.js"),
  }) as TestConvexForDataModelAndIdentity<any>;
}
