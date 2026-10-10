import { convexTest, type TestConvexForDataModel } from "convex-test";
import schema from "./schema.js";

/**
 * In-process Convex deployment used by relay tests. This exercises the actual
 * schema and Convex transaction runtime without requiring a networked
 * deployment or a checked-in generated `_generated` directory.
 */
export function createConvexTestHarness() {
  return convexTest(schema, {
    "./_generated/api.ts": async () => ({}),
    "./relay.ts": async () => import("./relay.js"),
  }) as TestConvexForDataModel<any>;
}

