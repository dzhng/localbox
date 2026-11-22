import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { appcast, signAppcast, sparklePublicKey, sparkleSignature, verifyAppcast } from "../scripts/appcast.js";

// A PKCS#8 Ed25519 key, the release key's format, from a fixed seed (bytes 0..31). The expected values are what the
// pinned Sparkle's own `sign_update --ed-key-file SEED` printed for the same seed (specs/done/menu-bar-app/choices.md, S28).
const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pem = key.export({ type: "pkcs8", format: "pem" }).toString();

test("an archive signature from the release key's format is the one Sparkle's sign_update makes", () => {
  assert.equal(sparkleSignature(Buffer.from("Localbox update archive\n"), pem), "EIKWHgbFzHZNJsrrwxJRmdhcBroQJYX+goxN94dYWBNKAhlue0fAmGDvWDlXQJokdELFzcykZEqzM+E6pmmmAw==");
});

test("a signed feed is byte for byte what sign_update --disable-signing-warning writes", () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Localbox</title></channel></rss>\n`;
  assert.equal(signAppcast(feed, pem), `${feed}<!-- sparkle-signatures:\nedSignature: U+/xmej/UnkGN2LnDlIdpKGBkKaycUfyMUTQUeD6aGEtfRJH6YNPU0wD24E9CNu7/eHSOs+O5Pe397mzB1UxBw==\nlength: 89\n-->\n`);
});

test("SUPublicEDKey is the raw public half, base64, whichever PEM half it is read from", () => {
  const expected = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  assert.equal(sparklePublicKey(pem), expected);
  assert.equal(sparklePublicKey(createPublicKey(key).export({ type: "spki", format: "pem" }).toString()), expected);
  assert.equal(Buffer.from(expected, "base64").length, 32);
  assert.throws(() => sparklePublicKey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), /Ed25519/);
});

test("a signed feed verifies with its public key and fails closed after any change", () => {
  const keys = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
  const feed = appcast({ version: "1.2.3", url: "https://github.com/o/r/releases/download/v1.2.3/Localbox-macos-arm64.zip", length: 10, signature: "c2ln", minimumSystemVersion: "14.0" });
  assert.match(feed, /<sparkle:version>1\.2\.3<\/sparkle:version>/);
  assert.match(feed, /<enclosure url="https:\/\/github\.com\/o\/r\/releases\/download\/v1\.2\.3\/Localbox-macos-arm64\.zip" length="10" type="application\/octet-stream" sparkle:edSignature="c2ln"\/>/);
  const signed = signAppcast(feed, keys.privateKey);
  assert.equal(verifyAppcast(signed, keys.publicKey), feed);
  assert.throws(() => verifyAppcast(signed, other.publicKey), /does not verify/);
  assert.throws(() => verifyAppcast(signed.replace("1.2.3", "1.2.4"), keys.publicKey), /does not verify/);
  assert.throws(() => verifyAppcast(feed, keys.publicKey), /not signed/);
});
