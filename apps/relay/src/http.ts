import type { Json } from "../../../packages/contract/src/index.js";
import { BlobError, isBlobReference, type BlobProvider } from "../../../packages/blob/src/index.js";
import type { RelayStateRepository, RequestFrameRecord } from "../../../packages/state/src/index.js";
import { StateConflictError, StateNotFoundError, StateUnauthorizedError } from "../../../packages/state/src/index.js";

export interface RelayHttpRequest { method: string; url: string; headers?: Record<string, string | undefined>; body?: unknown }
export interface RelayHttpResponse { status: number; headers: Record<string, string>; body: unknown }
export interface RelayHttpAdapterOptions { repository: RelayStateRepository; resource?: string; maxFrameBytes?: number; maxDeadlineMs?: number; maxPoll?: number; blobProvider?: BlobProvider; blobThresholdBytes?: number }

/** Stateless HTTP route adapter. It authenticates and commits repository transactions; it never dispatches guest operations. */
export class RelayHttpAdapter {
  readonly repository: RelayStateRepository;
  readonly resource: string;
  readonly maxFrameBytes: number;
  readonly maxDeadlineMs: number;
  readonly maxPoll: number;
  readonly blobProvider?: BlobProvider;
  readonly blobThresholdBytes: number;
  constructor(options: RelayHttpAdapterOptions) {
    this.repository = options.repository;
    this.resource = options.resource ?? "https://relay.example.test/mcp";
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.maxDeadlineMs = options.maxDeadlineMs ?? 120_000;
    this.maxPoll = options.maxPoll ?? 100;
    this.blobProvider = options.blobProvider;
    this.blobThresholdBytes = options.blobThresholdBytes ?? this.maxFrameBytes;
    if (!Number.isSafeInteger(this.blobThresholdBytes) || this.blobThresholdBytes < 1) throw new TypeError("blobThresholdBytes must be positive");
  }
  async handle(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const url = new URL(request.url, this.resource); const path = url.pathname.replace(/\/$/, "");
    try {
      if (request.method === "GET" && path === "/status") return await this.status(request);
      if ((path === "/agent/requests" || path === "/v1/requests") && request.method === "POST") return await this.submit(request);
      if (path.startsWith("/agent/responses/") && request.method === "GET") return await this.readResponse(request, path.slice("/agent/responses/".length));
      if (path.startsWith("/v1/requests/") && request.method === "GET") return await this.readResponse(request, path.slice("/v1/requests/".length));
      if (path.startsWith("/blobs/") && request.method === "GET") return await this.downloadBlob(request);
      if (path === "/host/poll" && request.method === "POST") return await this.poll(request);
      if (path.startsWith("/host/responses/") && request.method === "POST") return await this.complete(request, path.slice("/host/responses/".length));
      if (path === "/host/heartbeat" && request.method === "POST") return await this.heartbeat(request);
      if (path.startsWith("/channels/") && path.endsWith("/revoke") && request.method === "POST") return await this.revoke(request, path.split("/")[2]);
      return this.json(404, { error: "not_found" });
    } catch (error) { return this.error(error); }
  }
  private async submit(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const auth = await this.access(request); const body = this.object(request.body); this.limit(body);
    const vmId = this.string(body.vm_id); if (vmId !== auth.vm_id) throw new StateUnauthorizedError("request VM does not match access token");
    const operation = this.string(body.operation); const requestId = this.string(body.request_id); const payload = (body.payload ?? body.input ?? {}) as Json;
    const deadlineMs = body.deadline_ms === undefined ? 30_000 : this.number(body.deadline_ms); if (deadlineMs < 1 || deadlineMs > this.maxDeadlineMs) throw new StateConflictError("deadline exceeds relay limit");
    const record = await this.repository.enqueueRequest({ ownerId: auth.owner_id, vmId, requestId, operation, mutationId: body.mutation_id == null ? null : this.string(body.mutation_id), payload, deadlineAt: Date.now() + deadlineMs });
    return this.json(202, { request_id: record.requestId, frame_id: record.frameId, status: record.status });
  }
  private async readResponse(request: RelayHttpRequest, requestId: string): Promise<RelayHttpResponse> {
    const auth = await this.access(request); const snapshot = await this.repository.snapshot(); const frame = snapshot.requests.find((item) => item.requestId === requestId); if (!frame || frame.ownerId !== auth.owner_id) throw new StateNotFoundError("response not found");
    const response = await this.repository.getResponse(requestId); if (!response) return this.json(202, { request_id: requestId, status: frame.status });
    return this.json(200, response);
  }
  private async poll(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const channel = await this.channel(request); const body = this.object(request.body); const records = await this.repository.claimRequests({ ownerId: channel.ownerId, vmId: channel.vmId, leaseOwner: this.string(body.lease_owner), limit: Math.min(body.limit === undefined ? 20 : this.number(body.limit), this.maxPoll), leaseMs: body.lease_ms === undefined ? 30_000 : this.number(body.lease_ms) });
    return this.json(200, { channel_id: channel.channelId, epoch: channel.epoch, frames: records.map((record) => this.frame(record)) });
  }
  private async complete(request: RelayHttpRequest, requestId: string): Promise<RelayHttpResponse> {
    const channel = await this.channel(request); const body = this.object(request.body); const snapshot = await this.repository.snapshot(); const frame = snapshot.requests.find((item) => item.requestId === requestId); if (!frame || frame.ownerId !== channel.ownerId || frame.vmId !== channel.vmId) throw new StateNotFoundError("request not found");
    if (body.response === undefined) throw new StateConflictError("response is required");
    const response = await this.repository.recordResponse({ requestId, response: await this.externalizeResponse(body.response as Json), leaseOwner: body.lease_owner ? this.string(body.lease_owner) : undefined });
    return this.json(200, response);
  }
  private async downloadBlob(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    if (!this.blobProvider) throw new StateNotFoundError("blob storage is not configured");
    const blob = await this.blobProvider.get(request.url);
    return { status: 200, headers: { "content-type": blob.reference.content_type, "content-length": String(blob.reference.size_bytes), "cache-control": "private, max-age=0, must-revalidate", etag: `"${blob.reference.sha256}"` }, body: blob.body };
  }
  private async heartbeat(request: RelayHttpRequest): Promise<RelayHttpResponse> { const channel = await this.channel(request); return this.json(200, { channel_id: channel.channelId, vm_id: channel.vmId, epoch: channel.epoch, expires_at: channel.expiresAt }); }
  private async revoke(request: RelayHttpRequest, channelId: string): Promise<RelayHttpResponse> { const auth = await this.access(request); const snapshot = await this.repository.snapshot(); const channel = snapshot.channels.find((item) => item.channelId === channelId); if (!channel || channel.ownerId !== auth.owner_id) throw new StateNotFoundError("channel not found"); await this.repository.revokeChannel(channelId); return this.json(200, { channel_id: channelId, revoked: true }); }
  private async status(request: RelayHttpRequest): Promise<RelayHttpResponse> { const auth = await this.access(request); const snapshot = await this.repository.snapshot(); return this.json(200, { owner_id: auth.owner_id, vm_id: auth.vm_id, channels: snapshot.channels.filter((x) => x.ownerId === auth.owner_id && !x.revokedAt).length, queued: snapshot.requests.filter((x) => x.ownerId === auth.owner_id && x.status !== "completed").length }); }
  private async access(request: RelayHttpRequest): Promise<{ owner_id: string; vm_id: string }> { const token = this.bearer(request.headers?.authorization ?? request.headers?.Authorization); if (!token) throw new StateUnauthorizedError("missing bearer token"); const result = await this.repository.validateAccessToken(token, this.resource); return { owner_id: result.ownerId, vm_id: result.vmId }; }
  private async channel(request: RelayHttpRequest) { const headers = request.headers ?? {}; const channelId = headers["x-channel-id"]; const token = headers["x-channel-token"]; const epoch = Number(headers["x-channel-epoch"]); const vmId = headers["x-vm-id"]; if (!channelId || !token || !Number.isInteger(epoch) || !vmId) throw new StateUnauthorizedError("missing channel credentials"); const snapshot = await this.repository.snapshot(); const channel = snapshot.channels.find((item) => item.channelId === channelId); if (!channel) throw new StateNotFoundError("channel not found"); await this.repository.validateChannelGrant({ channelId, token, vmId, epoch }); return channel; }
  private bearer(value?: string): string | undefined { const match = value?.match(/^Bearer\s+(.+)$/i); return match?.[1]; }
  private object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new StateConflictError("JSON object body is required"); return value as Record<string, any>; }
  private string(value: unknown): string { if (typeof value !== "string" || !value) throw new StateConflictError("non-empty string is required"); return value; }
  private number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new StateConflictError("finite number is required"); return value; }
  private limit(body: unknown): void { if (Buffer.byteLength(JSON.stringify(body)) > this.maxFrameBytes) throw new StateConflictError("frame exceeds relay size limit"); }
  private frame(record: RequestFrameRecord): Record<string, unknown> {
    return {
      request_id: record.requestId,
      operation: record.operation,
      vm_id: record.vmId,
      mutation_id: record.mutationId,
      deadline_ms: Math.max(1, (record.deadlineAt ?? Date.now()) - Date.now()),
      payload: record.payload,
      lease_owner: record.leaseOwner,
      lease_expires_at: record.leaseExpiresAt,
    };
  }
  private json(status: number, body: unknown): RelayHttpResponse { return { status, headers: { "content-type": "application/json" }, body }; }
  private async externalizeResponse(response: Json): Promise<Json> {
    if (!this.blobProvider || !response || typeof response !== "object" || Array.isArray(response) || (response as Record<string, unknown>).ok !== true) return response;
    const envelope = response as Record<string, unknown>;
    if (isBlobReference(envelope.result)) return response;
    const serialized = JSON.stringify(envelope.result);
    if (serialized === undefined) return response;
    const encoded = Buffer.from(serialized);
    if (encoded.byteLength <= this.blobThresholdBytes) return response;
    const reference = await this.blobProvider.put({ body: encoded, contentType: "application/json" });
    return { ...envelope, result: reference } as unknown as Json;
  }
  private error(error: unknown): RelayHttpResponse {
    const message = error instanceof Error ? error.message : "relay request failed";
    if (error instanceof BlobError) {
      if (error.code === "not_found") return this.json(404, { error: "not_found", error_description: message });
      if (error.code === "expired") return this.json(410, { error: "blob_expired", error_description: message });
      return this.json(403, { error: "invalid_blob_reference", error_description: message });
    }
    if (error instanceof StateUnauthorizedError) return this.json(401, { error: "unauthorized", error_description: message });
    if (error instanceof StateNotFoundError) return this.json(404, { error: "not_found", error_description: message });
    if (error instanceof StateConflictError) return this.json(409, { error: "conflict", error_description: message });
    return this.json(500, { error: "internal_error" });
  }
}
export const RelayHttpServer = RelayHttpAdapter;
export function createRelayHttpAdapter(options: RelayHttpAdapterOptions): RelayHttpAdapter { return new RelayHttpAdapter(options); }
