import { internalQueryGeneric } from "convex/server";
import * as r from "./lib/relay.js";
/** Whole-database dump for tests and operators (`npx convex run`); never callable by clients. */
export const get = internalQueryGeneric({ args: {}, handler: async (ctx) => r.snapshot(ctx) });
