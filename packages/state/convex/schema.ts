import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The durable Convex schema for the relay state machine.
 *
 * The string IDs in these rows are application IDs. Convex's internal `_id`
 * remains an implementation detail, which keeps the repository contract
 * portable between the local harness and a deployed Convex project.
 */
const indexes = {
  accounts: defineTable({ accountId: v.string(), email: v.string(), name: v.string(), createdAt: v.number() }).index("by_account", ["accountId"]).index("by_email", ["email"]),
  machines: defineTable({ machineId: v.string(), accountId: v.string(), name: v.string(), credentialHash: v.string(), createdAt: v.number(), lastSeenAt: v.number(), revokedAt: v.optional(v.number()), capacity: v.optional(v.any()), capacityAt: v.optional(v.number()) }).index("by_machine", ["machineId"]).index("by_account", ["accountId"]).index("by_credential_hash", ["credentialHash"]),
  emailCodes: defineTable({ email: v.string(), codeHash: v.string(), expiresAt: v.number(), attempts: v.number(), createdAt: v.number() }).index("by_email", ["email"]).index("by_code_hash", ["codeHash"]),
  rateLimits: defineTable({ key: v.string(), bucket: v.string(), count: v.number(), resetAt: v.number() }).index("by_key_bucket", ["key", "bucket"]),
  owners: defineTable({ ownerId: v.string(), subject: v.string(), displayName: v.optional(v.string()), createdAt: v.number() }).index("by_subject", ["subject"]).index("by_owner", ["ownerId"]),
  vms: defineTable({ vmId: v.string(), ownerId: v.string(), name: v.optional(v.string()), createdAt: v.number(), revokedAt: v.optional(v.number()) }).index("by_vm", ["vmId"]).index("by_owner", ["ownerId"]),
  requests: defineTable({ requestId: v.string(), accountId: v.string(), machineId: v.string(), sandboxId: v.optional(v.string()), operation: v.string(), mutationId: v.optional(v.string()), payload: v.any(), payloadHash: v.string(), status: v.union(v.literal("queued"), v.literal("claimed"), v.literal("completed"), v.literal("abandoned")), createdAt: v.number(), claimDeadlineAt: v.number(), claimedAt: v.optional(v.number()) }).index("by_request_id", ["requestId"]).index("by_dedupe", ["machineId", "sandboxId", "operation", "mutationId"]).index("by_machine_status", ["machineId", "status"]).index("by_created", ["createdAt"]),
  responses: defineTable({ requestId: v.string(), accountId: v.string(), response: v.any(), bytes: v.number(), recordedAt: v.number() }).index("by_request_id", ["requestId"]).index("by_recorded", ["recordedAt"]),
  relayUsage: defineTable({ accountId: v.string(), day: v.string(), requests: v.number(), resultBytes: v.number() }).index("by_account_day", ["accountId", "day"]).index("by_day", ["day"]),
  authCodes: defineTable({ code: v.string(), codeHash: v.string(), ownerId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), vmId: v.string(), codeChallenge: v.string(), expiresAt: v.number(), scope: v.optional(v.string()), usedAt: v.optional(v.number()) }).index("by_code_hash", ["codeHash"]),
  oauthTokens: defineTable({ ownerId: v.string(), vmId: v.string(), resource: v.string(), scope: v.string(), familyId: v.string(), accessTokenHash: v.string(), refreshTokenHash: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number(), refreshUsedAt: v.optional(v.number()), replacementRefreshHash: v.optional(v.string()), revokedAt: v.optional(v.number()) }).index("by_access_hash", ["accessTokenHash"]).index("by_refresh_hash", ["refreshTokenHash"]).index("by_family", ["familyId"]),
  // Family revocation is a separate durable row so a replay can commit the
  // revocation atomically. Throwing after patching OAuth rows would roll back
  // the entire Convex mutation and leave the family usable.
  oauthRevocations: defineTable({ familyId: v.string(), revokedAt: v.number() }).index("by_family", ["familyId"]),
  audit: defineTable({ auditId: v.string(), ownerId: v.optional(v.string()), vmId: v.optional(v.string()), requestId: v.optional(v.string()), operation: v.string(), outcome: v.union(v.literal("success"), v.literal("error")), code: v.optional(v.string()), metadata: v.optional(v.any()), at: v.number() }).index("by_owner", ["ownerId"]).index("by_request", ["requestId"]),
  quotas: defineTable({ ownerId: v.string(), bucket: v.string(), used: v.number(), limit: v.number(), resetAt: v.number() }).index("by_owner_bucket", ["ownerId", "bucket"]),
};

/** Convex's production schema. */
const relaySchema = defineSchema(indexes);
export default relaySchema;

/** Stable metadata consumed by probes and the local repository contract. */
export const relayStateSchema = {
  accounts: { indexes: ["by_account", "by_email"] }, machines: { indexes: ["by_machine", "by_account", "by_credential_hash"] }, emailCodes: { indexes: ["by_email", "by_code_hash"] }, rateLimits: { indexes: ["by_key_bucket"] },
  owners: { indexes: ["by_subject", "by_owner"] }, vms: { indexes: ["by_vm", "by_owner"] },
  requests: { indexes: ["by_request_id", "by_dedupe", "by_machine_status", "by_created"] },
  responses: { indexes: ["by_request_id", "by_recorded"] }, relayUsage: { indexes: ["by_account_day", "by_day"] }, authCodes: { indexes: ["by_code_hash"] },
  oauthTokens: { indexes: ["by_access_hash", "by_refresh_hash", "by_family"] }, oauthRevocations: { indexes: ["by_family"] },
  audit: { indexes: ["by_owner", "by_request"] }, quotas: { indexes: ["by_owner_bucket"] },
} as const;
export type RelayStateTable = keyof typeof relayStateSchema;
