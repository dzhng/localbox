import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * Sparkle's update feed, signed with the release's Ed25519 key: the same PKCS#8 key that
 * signs `release.json`, so there is one trust root and one secret. Sparkle's EdDSA is plain Ed25519 (RFC 8032), so
 * Node's `sign(null, …)` gives the bytes Sparkle's `sign_update` would; tests/appcast.test.ts pins that against a
 * `sign_update` answer. The app carries the key's raw 32-byte public half, base64, as `SUPublicEDKey`.
 */
type Key = string | Buffer | KeyObject;

/** `SUPublicEDKey` for a PEM public or private key: the raw 32-byte Ed25519 public key, base64. */
export function sparklePublicKey(key: Key): string {
  const object = typeof key === "object" && "type" in key ? key : String(key).includes("PRIVATE") ? createPrivateKey(key as string | Buffer) : createPublicKey(key as string | Buffer);
  const jwk = (object.type === "private" ? createPublicKey(object) : object).export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("the update feed key must be an Ed25519 key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** `sparkle:edSignature` for an archive's bytes. */
export function sparkleSignature(bytes: Buffer, privateKey: Key): string {
  return sign(null, bytes, privateKey).toString("base64");
}

export interface AppcastItem {
  version: string;
  /** Where Sparkle downloads the update: the release's app zip. */
  url: string;
  /** The archive's byte length and `sparkleSignature`. */
  length: number;
  signature: string;
  minimumSystemVersion: string;
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A one-item feed: Sparkle offers the item when its version is newer than the running app's `CFBundleVersion`. */
export function appcast(item: AppcastItem): string {
  const version = escape(item.version);
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n<channel>\n<title>Localbox</title>\n<item>\n<title>${version}</title>\n<sparkle:version>${version}</sparkle:version>\n<sparkle:shortVersionString>${version}</sparkle:shortVersionString>\n<sparkle:minimumSystemVersion>${escape(item.minimumSystemVersion)}</sparkle:minimumSystemVersion>\n<enclosure url="${escape(item.url)}" length="${item.length}" type="application/octet-stream" sparkle:edSignature="${item.signature}"/>\n</item>\n</channel>\n</rss>\n`;
}

const SIGNING_PREFIX = "<!-- sparkle-signatures:\n";

/**
 * A signed feed (`SURequireSignedFeed`), as `sign_update FEED --disable-signing-warning` writes one: the feed's bytes,
 * then a comment carrying the signature over exactly those bytes and their length (Sparkle's `signAppcast`).
 */
export function signAppcast(feed: string, privateKey: Key): string {
  const content = Buffer.from(feed, "utf8");
  return `${feed}${SIGNING_PREFIX}edSignature: ${sparkleSignature(content, privateKey)}\nlength: ${content.length}\n-->\n`;
}

/** Checks a signed feed as Sparkle's `SPUExtractAppcastContent` reads it; returns the feed without its signature. */
export function verifyAppcast(signed: string, publicKey: Key): string {
  const bytes = Buffer.from(signed, "utf8");
  const at = bytes.lastIndexOf(SIGNING_PREFIX);
  if (at < 0) throw new Error("the feed is not signed");
  const content = bytes.subarray(0, at), block = bytes.subarray(at + SIGNING_PREFIX.length).toString("utf8");
  const signature = /^edSignature:\s*(\S+)$/m.exec(block)?.[1], length = Number(/^length:\s*(\d+)$/m.exec(block)?.[1]);
  if (!signature || length !== content.length || !verify(null, content, publicKey, Buffer.from(signature, "base64"))) throw new Error("the feed's signature does not verify");
  return content.toString("utf8");
}
