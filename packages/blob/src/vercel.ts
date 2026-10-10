import { createHash, randomBytes } from "node:crypto";
import { del, get, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { BlobError, BLOB_REFERENCE_KIND, type BlobProvider, type BlobPutInput, type BlobRecord, type BlobReference } from "./index.js";

export interface VercelBlobProviderOptions {
  token: string;
  basePath?: string;
  now?: () => number;
  maxTtlMs?: number;
  maxBytes?: number;
  sdk?: VercelBlobSdk;
}

export interface VercelBlobSdk {
  put: typeof put;
  get: typeof get;
  del: typeof del;
  issueSignedToken: typeof issueSignedToken;
  presignUrl: typeof presignUrl;
}

/**
 * Durable Vercel Blob implementation of the shared payload contract.
 *
 * Objects are private and are exposed only through short-lived Vercel
 * presigned URLs. The provider can mint a fresh URL from `blob_id` after an
 * old reference expires, so replay checks do not depend on the first URL's
 * lifetime.
 */
export class VercelBlobProvider implements BlobProvider {
  private readonly token: string;
  private readonly basePath: string;
  private readonly now: () => number;
  private readonly maxTtlMs: number;
  private readonly maxBytes: number;
  private readonly sdk: VercelBlobSdk;

  constructor(options: VercelBlobProviderOptions) {
    if (!options.token) throw new TypeError("Vercel Blob token is required");
    this.token = options.token;
    this.basePath = (options.basePath ?? "agent-computer").replace(/^\/+|\/+$/g, "") || "agent-computer";
    this.now = options.now ?? (() => Date.now());
    this.maxTtlMs = options.maxTtlMs ?? 15 * 60_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.sdk = options.sdk ?? { put, get, del, issueSignedToken, presignUrl };
    if (!Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs < 1) throw new TypeError("Vercel Blob maxTtlMs must be positive");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new TypeError("Vercel Blob maxBytes must be positive");
  }

  async put(input: BlobPutInput): Promise<BlobReference> {
    const body = toBytes(input.body);
    if (body.byteLength > this.maxBytes) throw new BlobError("blob exceeds provider limit", "too_large");
    const ttlMs = input.ttlMs ?? this.maxTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs) throw new BlobError("blob TTL exceeds provider limit", "invalid_reference");
    const pathname = `${this.basePath}/${randomBytes(16).toString("base64url")}`;
    const contentType = input.contentType ?? "application/octet-stream";
    if (!contentType || /[\r\n]/.test(contentType)) throw new BlobError("blob content type is invalid", "invalid_reference");
    await this.sdk.put(pathname, body, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType, token: this.token });
    return await this.reference(pathname, body.byteLength, contentType, digest(body), ttlMs);
  }

  async get(signed: string | BlobReference): Promise<BlobRecord> {
    const pathname = this.pathnameFrom(signed);
    const result = await this.sdk.get(pathname, { access: "private", token: this.token, useCache: false });
    if (!result || result.statusCode !== 200) throw new BlobError("blob was not found", "not_found");
    const body = Buffer.from(await new Response(result.stream).arrayBuffer());
    const contentType = result.blob.contentType || (typeof signed === "object" ? signed.content_type : "application/octet-stream");
    const reference = await this.reference(pathname, body.byteLength, contentType, digest(body), this.maxTtlMs);
    return { reference, body };
  }

  async delete(signed: string | BlobReference): Promise<void> {
    await this.sdk.del(this.pathnameFrom(signed), { token: this.token });
  }

  private pathnameFrom(value: string | BlobReference): string {
    const pathname = pathnameFrom(value);
    if (pathname !== this.basePath && !pathname.startsWith(`${this.basePath}/`)) throw new BlobError("blob pathname is outside the configured prefix", "invalid_reference");
    return pathname;
  }

  private async reference(pathname: string, sizeBytes: number, contentType: string, sha256: string, ttlMs: number): Promise<BlobReference> {
    const expiresAt = this.now() + ttlMs;
    const signed = await this.sdk.issueSignedToken({ pathname, operations: ["get", "delete"], validUntil: expiresAt, token: this.token });
    const presigned = await this.sdk.presignUrl(signed, { operation: "get", pathname, validUntil: expiresAt, access: "private" });
    return {
      kind: BLOB_REFERENCE_KIND,
      blob_id: pathname,
      download_url: presigned.presignedUrl,
      sha256,
      size_bytes: sizeBytes,
      content_type: contentType,
      expires_at: expiresAt,
    };
  }
}

function pathnameFrom(value: string | BlobReference): string {
  const raw = typeof value === "string" ? value : value.download_url;
  let url: URL;
  try { url = new URL(raw); } catch { throw new BlobError("invalid blob URL", "invalid_reference"); }
  const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!pathname || pathname.includes("..")) throw new BlobError("invalid blob pathname", "invalid_reference");
  return pathname;
}

function toBytes(body: BlobPutInput["body"]): Buffer {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("blob body must be bytes or a string");
}

function digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}
