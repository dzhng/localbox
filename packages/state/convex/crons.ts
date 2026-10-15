import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
crons.daily("relay cleanup", { hourUTC: 3, minuteUTC: 17 }, makeFunctionReference<"mutation">("relay:cleanupExpired") as any);
export default crons;
