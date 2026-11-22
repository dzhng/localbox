import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A throwaway self-signed code-signing identity, as the files `scripts/release.sh` reads for the real one
 * (`release-identity.p12` and its password file), so probes sign exactly as a release does without the release
 * identity. sign.mjs imports it into a disposable keychain; nothing here touches a keychain. Never a release credential.
 */
export function scratchIdentity(dir: string, name = "Localbox Scratch"): { p12: string; passwordFile: string; sha1: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  const config = join(dir, "openssl.cnf"), key = join(dir, "key.pem"), certificate = join(dir, "certificate.pem");
  const p12 = join(dir, "release-identity.p12"), passwordFile = join(dir, "release-identity-password.txt");
  writeFileSync(config, `[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = ${name}\n[ext]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\n`);
  // The system's LibreSSL writes a PKCS#12 that `security import` reads (OpenSSL 3's default ciphers it may not).
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", config, "-keyout", key, "-out", certificate], { stdio: "ignore" });
  execFileSync("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", certificate, "-name", name, "-passout", `pass:${password}`, "-out", p12], { stdio: "ignore" });
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const sha1 = execFileSync("/usr/bin/openssl", ["x509", "-in", certificate, "-noout", "-fingerprint", "-sha1"], { encoding: "utf8" }).replace(/.*=/, "").replaceAll(":", "").trim().toLowerCase();
  rmSync(key);
  return { p12, passwordFile, sha1 };
}
