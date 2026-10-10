/** Convex schema contract. The production deployment can map these definitions to Convex tables. */
export const relayStateSchema = {
  owners: { indexes: ["by_subject"] },
  vms: { indexes: ["by_owner"] },
  channels: { indexes: ["by_channel", "by_vm"] },
  requests: { indexes: ["by_request_id", "by_dedupe", "by_lease"] },
  responses: { indexes: ["by_request_id"] },
  authCodes: { indexes: ["by_code_hash"] },
  oauthTokens: { indexes: ["by_access_hash", "by_refresh_hash", "by_family"] },
  audit: { indexes: ["by_owner", "by_request"] },
  quotas: { indexes: ["by_owner_bucket"] },
} as const;
export type RelayStateTable = keyof typeof relayStateSchema;
