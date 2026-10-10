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
  owners: defineTable({ ownerId: v.string(), subject: v.string(), displayName: v.optional(v.string()), createdAt: v.number() }).index("by_subject", ["subject"]).index("by_owner", ["ownerId"]),
  vms: defineTable({ vmId: v.string(), ownerId: v.string(), name: v.optional(v.string()), createdAt: v.number(), revokedAt: v.optional(v.number()) }).index("by_vm", ["vmId"]).index("by_owner", ["ownerId"]),
  channels: defineTable({ channelId: v.string(), ownerId: v.string(), vmId: v.string(), tokenHash: v.string(), epoch: v.number(), expiresAt: v.number(), revokedAt: v.optional(v.number()) }).index("by_channel", ["channelId"]).index("by_vm", ["vmId"]).index("by_owner", ["ownerId"]).index("by_owner_vm", ["ownerId", "vmId"]),
  requests: defineTable({ frameId: v.string(), ownerId: v.string(), vmId: v.string(), requestId: v.string(), operation: v.string(), mutationId: v.optional(v.string()), payload: v.any(), payloadHash: v.string(), status: v.union(v.literal("queued"), v.literal("leased"), v.literal("completed")), createdAt: v.number(), deadlineAt: v.optional(v.number()), leaseOwner: v.optional(v.string()), leaseExpiresAt: v.optional(v.number()) }).index("by_request_id", ["requestId"]).index("by_dedupe", ["vmId", "operation", "mutationId"]).index("by_lease", ["status", "leaseExpiresAt"]).index("by_owner_status", ["ownerId", "status"]).index("by_owner_vm_status_lease", ["ownerId", "vmId", "status", "leaseExpiresAt"]),
  responses: defineTable({ requestId: v.string(), response: v.any(), responseHash: v.string(), recordedAt: v.number() }).index("by_request_id", ["requestId"]),
  authCodes: defineTable({ code: v.string(), codeHash: v.string(), ownerId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), vmId: v.string(), codeChallenge: v.string(), expiresAt: v.number(), scope: v.optional(v.string()), usedAt: v.optional(v.number()) }).index("by_code_hash", ["codeHash"]),
  oauthTokens: defineTable({ ownerId: v.string(), vmId: v.string(), resource: v.string(), scope: v.string(), familyId: v.string(), accessTokenHash: v.string(), refreshTokenHash: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number(), refreshUsedAt: v.optional(v.number()), replacementRefreshHash: v.optional(v.string()), revokedAt: v.optional(v.number()) }).index("by_access_hash", ["accessTokenHash"]).index("by_refresh_hash", ["refreshTokenHash"]).index("by_family", ["familyId"]),
  audit: defineTable({ auditId: v.string(), ownerId: v.optional(v.string()), vmId: v.optional(v.string()), requestId: v.optional(v.string()), operation: v.string(), outcome: v.union(v.literal("success"), v.literal("error")), code: v.optional(v.string()), metadata: v.optional(v.any()), at: v.number() }).index("by_owner", ["ownerId"]).index("by_request", ["requestId"]),
  quotas: defineTable({ ownerId: v.string(), bucket: v.string(), used: v.number(), limit: v.number(), resetAt: v.number() }).index("by_owner_bucket", ["ownerId", "bucket"]),
};

/** Convex's production schema. */
const relaySchema = defineSchema(indexes);
export default relaySchema;

/** Stable metadata consumed by probes and the local repository contract. */
export const relayStateSchema = {
  owners: { indexes: ["by_subject", "by_owner"] }, vms: { indexes: ["by_vm", "by_owner"] },
  channels: { indexes: ["by_channel", "by_vm", "by_owner", "by_owner_vm"] }, requests: { indexes: ["by_request_id", "by_dedupe", "by_lease", "by_owner_status", "by_owner_vm_status_lease"] },
  responses: { indexes: ["by_request_id"] }, authCodes: { indexes: ["by_code_hash"] },
  oauthTokens: { indexes: ["by_access_hash", "by_refresh_hash", "by_family"] },
  audit: { indexes: ["by_owner", "by_request"] }, quotas: { indexes: ["by_owner_bucket"] },
} as const;
export type RelayStateTable = keyof typeof relayStateSchema;
