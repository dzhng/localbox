import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Versioned JSON value returned in operation results for large/binary payloads. */
export const BLOB_REFERENCE_KIND = "agent-computer/blob-reference-v1" as const;
export type BlobReferenceKind = typeof BLOB_REFERENCE_KIND;

export interface BlobReference {
  /** Blob references are JSON values and can be returned in a contract result. */
  [key: string]: string | number;
  kind: BlobReferenceKind;
  blob_id: string;
  download_url: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  expires_at: number;
}

export interface BlobPutInput {
  body: Uint8Array | ArrayBuffer | string;
  contentType?: string;
  ttlMs?: number;
}

export interface BlobRecord {
  reference: BlobReference;
  body: Uint8Array;
}

export interface BlobProvider {
  put(input: BlobPutInput): Promise<BlobReference>;
  /** Resolve only a signed URL or a complete BlobReference. */
  get(signed: string | BlobReference): Promise<BlobRecord>;
  delete(signed: string | BlobReference): Promise<void>;
}

export class BlobError extends Error {
  constructor(message: string, public readonly code: "invalid_reference" | "not_found" | "expired" | "too_large" = "invalid_reference") {
    super(message);
    this.name = "BlobError";
  }
}

export interface InMemoryBlobProviderOptions {
  /** Secret used to sign references. Keep this in a deployment secret. */
  secret?: string | Uint8Array;
  /** Origin used in signed download URLs, for example https://relay.example.com. */
  baseUrl?: string;
  now?: () => number;
  maxTtlMs?: number;
  maxBytes?: number;
}

interface StoredBlob {
  reference: BlobReference;
  body: Uint8Array;
}

/**
 * Deterministic local provider used by the Convex/relay harness.
 *
 * The data map is deliberately process-local; production should implement the
 * same BlobProvider contract with object storage. The signature format and
 * reference fields are stable so a provider can be swapped without changing
 * operation responses.
 */
export class InMemoryBlobProvider implements BlobProvider {
  readonly baseUrl: string;
  readonly maxTtlMs: number;
  readonly maxBytes: number;
  private readonly secret: Uint8Array;
  private readonly now: () => number;
  private readonly blobs = new Map<string, StoredBlob>();

  constructor(options: InMemoryBlobProviderOptions = {}) {
    const secret = options.secret ?? randomBytes(32);
    this.secret = typeof secret === "string" ? Buffer.from(secret) : Buffer.from(secret);
    if (this.secret.byteLength < 16) throw new TypeError("blob signing secret must be at least 16 bytes");
    this.baseUrl = (options.baseUrl ?? "https://blob.local").replace(/\/$/, "");
    this.now = options.now ?? (() => Date.now());
    this.maxTtlMs = options.maxTtlMs ?? 15 * 60_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs < 1) throw new TypeError("blob maxTtlMs must be positive");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new TypeError("blob maxBytes must be positive");
  }

  async put(input: BlobPutInput): Promise<BlobReference> {
    const body = toBytes(input.body);
    if (body.byteLength > this.maxBytes) throw new BlobError("blob exceeds provider limit", "too_large");
    const ttlMs = input.ttlMs ?? this.maxTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs) throw new BlobError("blob TTL exceeds provider limit", "invalid_reference");
    const blobId = randomBytes(16).toString("base64url");
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const expiresAt = this.now() + ttlMs;
    const signature = this.sign(blobId, expiresAt, digest, body.byteLength);
    const url = new URL(`/blobs/${encodeURIComponent(blobId)}`, `${this.baseUrl}/`);
    url.searchParams.set("expires", String(expiresAt));
    url.searchParams.set("signature", signature);
    const reference: BlobReference = {
      kind: BLOB_REFERENCE_KIND,
      blob_id: blobId,
      download_url: url.toString(),
      sha256: digest,
      size_bytes: body.byteLength,
      content_type: input.contentType ?? "application/octet-stream",
      expires_at: expiresAt,
    };
    this.blobs.set(blobId, { reference, body: Buffer.from(body) });
    return cloneReference(reference);
  }

  async get(signed: string | BlobReference): Promise<BlobRecord> {
    const parsed = parseSignedReference(signed);
    if (parsed.expiresAt <= this.now()) throw new BlobError("blob reference has expired", "expired");
    const stored = this.blobs.get(parsed.blobId);
    if (!stored) throw new BlobError("blob was not found", "not_found");
    const expected = this.sign(parsed.blobId, parsed.expiresAt, stored.reference.sha256, stored.reference.size_bytes);
    if (!constantTimeEqual(expected, parsed.signature) || stored.reference.expires_at !== parsed.expiresAt) throw new BlobError("blob signature is invalid", "invalid_reference");
    return { reference: cloneReference(stored.reference), body: Buffer.from(stored.body) };
  }

  async delete(signed: string | BlobReference): Promise<void> {
    const parsed = parseSignedReference(signed);
    if (parsed.expiresAt <= this.now()) throw new BlobError("blob reference has expired", "expired");
    const stored = this.blobs.get(parsed.blobId);
    if (!stored) return;
    const expected = this.sign(parsed.blobId, parsed.expiresAt, stored.reference.sha256, stored.reference.size_bytes);
    if (!constantTimeEqual(expected, parsed.signature) || stored.reference.expires_at !== parsed.expiresAt) throw new BlobError("blob signature is invalid", "invalid_reference");
    this.blobs.delete(parsed.blobId);
  }

  /** Useful for tests and lifecycle jobs; no authorization bypass is exposed. */
  size(): number { return this.blobs.size; }

  private sign(blobId: string, expiresAt: number, digest: string, size: number): string {
    return createHmac("sha256", this.secret).update(`${blobId}.${expiresAt}.${digest}.${size}`).digest("base64url");
  }
}

export function isBlobReference(value: unknown): value is BlobReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<BlobReference>;
  return candidate.kind === BLOB_REFERENCE_KIND && typeof candidate.blob_id === "string" && typeof candidate.download_url === "string" && typeof candidate.sha256 === "string" && typeof candidate.size_bytes === "number" && Number.isSafeInteger(candidate.size_bytes) && typeof candidate.content_type === "string" && typeof candidate.expires_at === "number" && Number.isSafeInteger(candidate.expires_at);
}

function parseSignedReference(value: string | BlobReference): { blobId: string; expiresAt: number; signature: string } {
  const raw = typeof value === "string" ? value : (isBlobReference(value) ? value.download_url : "");
  if (!raw) throw new BlobError("invalid blob reference", "invalid_reference");
  let url: URL;
  try { url = new URL(raw); } catch { throw new BlobError("invalid blob URL", "invalid_reference"); }
  const match = url.pathname.match(/\/blobs\/([^/]+)$/);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (!match || !signature || !Number.isSafeInteger(expires) || expires < 1) throw new BlobError("invalid blob signature", "invalid_reference");
  let blobId: string;
  try { blobId = decodeURIComponent(match[1]); } catch { throw new BlobError("invalid blob ID", "invalid_reference"); }
  if (!blobId) throw new BlobError("invalid blob ID", "invalid_reference");
  return { blobId, expiresAt: expires, signature };
}

function toBytes(body: BlobPutInput["body"]): Uint8Array {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  throw new TypeError("blob body must be bytes or a string");
}

function cloneReference(reference: BlobReference): BlobReference { return { ...reference }; }
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
