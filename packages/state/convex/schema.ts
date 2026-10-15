import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The durable Convex schema for the relay state machine.
 *
 * The string IDs in these rows are application IDs. Convex's internal `_id`
 * remains an implementation detail.
 */
const indexes = {
  accounts: defineTable({ accountId: v.string(), email: v.string(), name: v.string(), createdAt: v.number() }).index("by_account", ["accountId"]).index("by_email", ["email"]),
  machines: defineTable({ machineId: v.string(), accountId: v.string(), name: v.string(), credentialHash: v.string(), createdAt: v.number(), lastSeenAt: v.number(), revokedAt: v.optional(v.number()), capacity: v.optional(v.any()), capacityAt: v.optional(v.number()) }).index("by_machine", ["machineId"]).index("by_account", ["accountId"]).index("by_credential_hash", ["credentialHash"]),
  // Identity of every sandbox; the daemon on `machineId` keeps a read-only mirror and reports `reportedState` back.
  sandboxes: defineTable({ sandboxId: v.string(), accountId: v.string(), machineId: v.string(), name: v.string(), cpus: v.number(), memoryBytes: v.number(), sleepAfterMs: v.number(), deleteAfterMs: v.optional(v.number()), reportedState: v.optional(v.string()), reportedAt: v.optional(v.number()), createdAt: v.number() }).index("by_sandbox", ["sandboxId"]).index("by_account", ["accountId"]).index("by_account_name", ["accountId", "name"]).index("by_machine", ["machineId"]),
  emailCodes: defineTable({ email: v.string(), codeHash: v.string(), expiresAt: v.number(), attempts: v.number(), createdAt: v.number() }).index("by_email", ["email"]).index("by_code_hash", ["codeHash"]),
  rateLimits: defineTable({ key: v.string(), bucket: v.string(), count: v.number(), resetAt: v.number() }).index("by_key_bucket", ["key", "bucket"]),
  requests: defineTable({ requestId: v.string(), accountId: v.string(), machineId: v.string(), sandboxId: v.optional(v.string()), operation: v.string(), mutationId: v.optional(v.string()), payload: v.any(), payloadHash: v.string(), status: v.union(v.literal("queued"), v.literal("claimed"), v.literal("completed"), v.literal("abandoned")), createdAt: v.number(), claimDeadlineAt: v.number(), claimedAt: v.optional(v.number()) }).index("by_request_id", ["requestId"]).index("by_dedupe", ["machineId", "sandboxId", "operation", "mutationId"]).index("by_machine_status", ["machineId", "status"]).index("by_created", ["createdAt"]),
  responses: defineTable({ requestId: v.string(), accountId: v.string(), response: v.any(), bytes: v.number(), recordedAt: v.number() }).index("by_request_id", ["requestId"]).index("by_recorded", ["recordedAt"]),
  relayUsage: defineTable({ accountId: v.string(), day: v.string(), requests: v.number(), resultBytes: v.number() }).index("by_account_day", ["accountId", "day"]).index("by_day", ["day"]),
  oauthClients: defineTable({ clientId: v.string(), clientName: v.string(), redirectUris: v.array(v.string()), createdAt: v.number() }).index("by_client", ["clientId"]),
  // `familyId` is set when the code is exchanged, so a replayed code can revoke what it issued.
  authCodes: defineTable({ codeHash: v.string(), accountId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), codeChallenge: v.string(), expiresAt: v.number(), usedAt: v.optional(v.number()), familyId: v.optional(v.string()) }).index("by_code_hash", ["codeHash"]),
  oauthTokens: defineTable({ accountId: v.string(), clientId: v.string(), scopes: v.array(v.literal("account")), constraints: v.null(), familyId: v.string(), accessTokenHash: v.string(), refreshTokenHash: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number(), refreshUsedAt: v.optional(v.number()), revokedAt: v.optional(v.number()) }).index("by_access_hash", ["accessTokenHash"]).index("by_refresh_hash", ["refreshTokenHash"]).index("by_family", ["familyId"]),
  // Family revocation is a separate durable row so a replay can commit the
  // revocation atomically. Throwing after patching OAuth rows would roll back
  // the entire Convex mutation and leave the family usable.
  oauthRevocations: defineTable({ familyId: v.string(), revokedAt: v.number() }).index("by_family", ["familyId"]),
};

/** Convex's production schema. */
const relaySchema = defineSchema(indexes);
export default relaySchema;

/** Table and index names, for the whole-database snapshot and probes. */
export const relayStateSchema = {
  accounts: { indexes: ["by_account", "by_email"] }, machines: { indexes: ["by_machine", "by_account", "by_credential_hash"] }, sandboxes: { indexes: ["by_sandbox", "by_account", "by_account_name", "by_machine"] }, emailCodes: { indexes: ["by_email", "by_code_hash"] }, rateLimits: { indexes: ["by_key_bucket"] },
  requests: { indexes: ["by_request_id", "by_dedupe", "by_machine_status", "by_created"] },
  responses: { indexes: ["by_request_id", "by_recorded"] }, relayUsage: { indexes: ["by_account_day", "by_day"] }, oauthClients: { indexes: ["by_client"] }, authCodes: { indexes: ["by_code_hash"] },
  oauthTokens: { indexes: ["by_access_hash", "by_refresh_hash", "by_family"] }, oauthRevocations: { indexes: ["by_family"] },
} as const;
export type RelayStateTable = keyof typeof relayStateSchema;
