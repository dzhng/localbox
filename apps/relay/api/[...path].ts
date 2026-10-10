import { ConvexHttpClient } from "convex/browser";
import { ConvexRelayStateRepository, InMemoryRelayStateRepository } from "../../../packages/state/src/index.js";
import { createVercelRelayHandler } from "../src/vercel.js";

// This module is a deployable adapter, while production wiring can replace the
// repository with the Convex implementation without changing the HTTP routes.
const repository = process.env.CONVEX_URL
  ? new ConvexRelayStateRepository(new ConvexHttpClient(process.env.CONVEX_URL, { skipConvexDeploymentUrlCheck: true }), process.env.CONVEX_DEPLOYMENT ?? "convex")
  : new InMemoryRelayStateRepository({ deploymentId: process.env.CONVEX_DEPLOYMENT ?? "vercel-local" });
const handle = createVercelRelayHandler(repository, { resource: process.env.AGENT_COMPUTER_RESOURCE });

export default handle;

