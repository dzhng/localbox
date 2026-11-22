import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The durable Convex schema for the relay state machine.
 *
 * The string IDs in these rows are application IDs. Convex's internal `_id`
 * remains an implementation detail.
 */
export const imageOs = v.union(v.literal("linux"), v.literal("macos"));
export const holderState = v.union(v.literal("building"), v.literal("copying"), v.literal("ready"), v.literal("failed"));
export const imageSource = v.object({ kind: v.union(v.literal("sandbox"), v.literal("ipsw")), sandboxName: v.optional(v.string()), ipswVersion: v.optional(v.string()) });
/** Why a holder's operation failed and what to try next, as its machine reported it. */
export const holderFailure = v.object({ code: v.string(), message: v.string(), nextStep: v.string() });
/** An address one end of a copy can be reached at, as its transfer library gathered it (local, reflexive, ...). */
export const copyCandidate = v.object({ kind: v.string(), address: v.string(), port: v.number() });
export const copyState = v.union(v.literal("waiting"), v.literal("copying"), v.literal("copied"), v.literal("failed"));
export const copyPath = v.union(v.literal("local_network"), v.literal("internet"));
/** What a finished copy moved: bytes over the wire, how long it took, and the path that won. */
export const copyResult = v.object({ bytes: v.number(), durationMs: v.number(), path: copyPath });

const indexes = {
  // `defaultImageId` absent means the built-in `linux`.
  accounts: defineTable({ accountId: v.string(), email: v.string(), name: v.string(), createdAt: v.number(), defaultImageId: v.optional(v.string()) }).index("by_account", ["accountId"]).index("by_email", ["email"]),
  machines: defineTable({ machineId: v.string(), accountId: v.string(), name: v.string(), credentialHash: v.string(), createdAt: v.number(), lastSeenAt: v.number(), revokedAt: v.optional(v.number()), capacity: v.optional(v.any()), capacityAt: v.optional(v.number()) }).index("by_machine", ["machineId"]).index("by_account", ["accountId"]).index("by_credential_hash", ["credentialHash"]).index("by_account_revoked", ["accountId", "revokedAt"]).index("by_revoked", ["revokedAt"]),
  // Identity of every sandbox; the daemon on `machineId` keeps a read-only mirror and reports `reportedState` back.
  // `createMutationId` is the create's mutation id, so a replayed create finds the sandbox it already reserved.
  // `copyOperationId` is the image copy a sandbox made on a Mac without its image waited for; `pending` is `copying`
  // until its machine reports the create done, or `failed` with `pendingError` (why, and what to try next).
  sandboxes: defineTable({ sandboxId: v.string(), accountId: v.string(), machineId: v.string(), name: v.string(), imageId: v.string(), os: imageOs, minMacOS: v.optional(v.string()), cpus: v.number(), memoryBytes: v.number(), sleepAfterMs: v.number(), deleteAfterMs: v.optional(v.number()), reportedState: v.optional(v.string()), reportedAt: v.optional(v.number()), createdAt: v.number(), createMutationId: v.optional(v.string()), copyOperationId: v.optional(v.string()), pending: v.optional(v.union(v.literal("copying"), v.literal("failed"))), pendingError: v.optional(holderFailure) }).index("by_sandbox", ["sandboxId"]).index("by_account", ["accountId"]).index("by_account_name", ["accountId", "name"]).index("by_machine", ["machineId"]).index("by_account_mutation", ["accountId", "createMutationId"]),
  // An image's identity (`images.ts` owns both tables). `sizeBytes` is absent until a holder reports the image ready;
  // `minMacOS` is the oldest host macOS that runs a macOS image.
  images: defineTable({ imageId: v.string(), accountId: v.string(), name: v.string(), os: imageOs, sizeBytes: v.optional(v.number()), source: imageSource, minMacOS: v.optional(v.string()), createdAt: v.number(), createMutationId: v.string() }).index("by_image", ["imageId"]).index("by_account_name", ["accountId", "name"]).index("by_account_mutation", ["accountId", "createMutationId"]),
  // Which machines hold an image, as their connectors report it; `operationId` is the host operation building or copying
  // it, and `error` why it failed (set only while `state` is failed).
  imageHolders: defineTable({ imageId: v.string(), accountId: v.string(), machineId: v.string(), state: holderState, operationId: v.optional(v.string()), error: v.optional(holderFailure), updatedAt: v.number() }).index("by_image_machine", ["imageId", "machineId"]).index("by_account", ["accountId"]).index("by_machine", ["machineId"]),
  // One image copy between two of the account's Macs, the rendezvous their connectors meet at (`images.ts` owns it):
  // `key` is the copy's one-time transfer key, readable only by those two machines; `candidates` are where each end
  // can be reached. `state` is waiting until both ends published candidates, then copying, then copied or failed.
  // `createMutationId` is the copy's mutation id, which both Macs journal their side under. `forSandbox` marks a copy a
  // sandbox create started, which stops once no sandbox waits on it.
  copies: defineTable({ copyId: v.string(), accountId: v.string(), imageId: v.string(), fromMachineId: v.string(), toMachineId: v.string(), key: v.string(), candidates: v.object({ from: v.optional(v.array(copyCandidate)), to: v.optional(v.array(copyCandidate)) }), state: copyState, result: v.optional(copyResult), error: v.optional(holderFailure), createdAt: v.number(), expiresAt: v.number(), createMutationId: v.string(), forSandbox: v.optional(v.boolean()) }).index("by_copy", ["copyId"]).index("by_account_mutation", ["accountId", "createMutationId"]).index("by_from", ["fromMachineId"]).index("by_to", ["toMachineId"]).index("by_image", ["imageId"]).index("by_expires", ["expiresAt"]),
  emailCodes: defineTable({ email: v.string(), codeHash: v.string(), expiresAt: v.number(), attempts: v.number(), createdAt: v.number() }).index("by_email", ["email"]).index("by_code_hash", ["codeHash"]).index("by_expires", ["expiresAt"]),
  rateLimits: defineTable({ key: v.string(), bucket: v.string(), count: v.number(), resetAt: v.number() }).index("by_key_bucket", ["key", "bucket"]).index("by_reset", ["resetAt"]),
  requests: defineTable({ requestId: v.string(), accountId: v.string(), machineId: v.string(), sandboxId: v.optional(v.string()), operation: v.string(), mutationId: v.optional(v.string()), payload: v.any(), payloadHash: v.string(), status: v.union(v.literal("queued"), v.literal("claimed"), v.literal("completed"), v.literal("abandoned")), createdAt: v.number(), claimDeadlineAt: v.number(), claimedAt: v.optional(v.number()) }).index("by_request_id", ["requestId"]).index("by_dedupe", ["machineId", "sandboxId", "operation", "mutationId"]).index("by_machine_status", ["machineId", "status"]).index("by_created", ["createdAt"]),
  responses: defineTable({ requestId: v.string(), accountId: v.string(), response: v.any(), bytes: v.number(), recordedAt: v.number() }).index("by_request_id", ["requestId"]).index("by_recorded", ["recordedAt"]),
  relayUsage: defineTable({ accountId: v.string(), day: v.string(), requests: v.number(), resultBytes: v.number() }).index("by_account_day", ["accountId", "day"]).index("by_day", ["day"]),
  oauthClients: defineTable({ clientId: v.string(), clientName: v.string(), redirectUris: v.array(v.string()), createdAt: v.number() }).index("by_client", ["clientId"]),
  // `familyId` is set when the code is exchanged, so a replayed code can revoke what it issued.
  authCodes: defineTable({ codeHash: v.string(), accountId: v.string(), clientId: v.string(), redirectUri: v.string(), resource: v.string(), codeChallenge: v.string(), expiresAt: v.number(), usedAt: v.optional(v.number()), familyId: v.optional(v.string()) }).index("by_code_hash", ["codeHash"]).index("by_expires", ["expiresAt"]),
  oauthTokens: defineTable({ accountId: v.string(), clientId: v.string(), scopes: v.array(v.literal("account")), constraints: v.null(), familyId: v.string(), accessTokenHash: v.string(), refreshTokenHash: v.string(), accessExpiresAt: v.number(), refreshExpiresAt: v.number(), refreshUsedAt: v.optional(v.number()) }).index("by_access_hash", ["accessTokenHash"]).index("by_refresh_hash", ["refreshTokenHash"]).index("by_family", ["familyId"]).index("by_refresh_expires", ["refreshExpiresAt"]),
  // A family holds its current token row and the one it rotated from (whose used refresh hash detects a replay);
  // rotation deletes anything older. Revocation is this separate row alone, checked by every token use, so a
  // replay commits it atomically and no family is too large to revoke.
  oauthRevocations: defineTable({ familyId: v.string(), revokedAt: v.number() }).index("by_family", ["familyId"]).index("by_revoked", ["revokedAt"]),
};

/** Convex's production schema. */
const relaySchema = defineSchema(indexes);
export default relaySchema;

/** Table and index names, for the whole-database snapshot and probes. */
export const relayStateSchema = {
  accounts: { indexes: ["by_account", "by_email"] }, machines: { indexes: ["by_machine", "by_account", "by_credential_hash", "by_account_revoked", "by_revoked"] }, sandboxes: { indexes: ["by_sandbox", "by_account", "by_account_name", "by_machine", "by_account_mutation"] },
  images: { indexes: ["by_image", "by_account_name", "by_account_mutation"] }, imageHolders: { indexes: ["by_image_machine", "by_account", "by_machine"] },
  copies: { indexes: ["by_copy", "by_account_mutation", "by_from", "by_to", "by_image", "by_expires"] }, emailCodes: { indexes: ["by_email", "by_code_hash", "by_expires"] }, rateLimits: { indexes: ["by_key_bucket", "by_reset"] },
  requests: { indexes: ["by_request_id", "by_dedupe", "by_machine_status", "by_created"] },
  responses: { indexes: ["by_request_id", "by_recorded"] }, relayUsage: { indexes: ["by_account_day", "by_day"] }, oauthClients: { indexes: ["by_client"] }, authCodes: { indexes: ["by_code_hash", "by_expires"] },
  oauthTokens: { indexes: ["by_access_hash", "by_refresh_hash", "by_family", "by_refresh_expires"] }, oauthRevocations: { indexes: ["by_family", "by_revoked"] },
} as const;
export type RelayStateTable = keyof typeof relayStateSchema;
