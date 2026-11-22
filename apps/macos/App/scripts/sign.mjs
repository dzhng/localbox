#!/usr/bin/env node
// Code-signs an assembled Localbox.app inside out.
//
//   node apps/macos/App/scripts/sign.mjs APP --identity ID [--keychain PATH]          an identity already in a keychain ("-" is ad hoc)
//   node apps/macos/App/scripts/sign.mjs APP --p12 FILE --password-file FILE [--sha1 HEX]
//
// With `--p12` the identity is imported into a disposable keychain, used for this one signing and deleted, so the key
// never enters the login keychain and nothing waits on a keychain dialog; `--sha1` refuses any other certificate. A
// p12 file may be base64 text. Every Mach-O file is signed before the bundle that seals it, with no `--deep` and no
// timestamp (the identity is self-signed, there is no notarization). `MacOS/localbox-hostd` alone gets the
// virtualization entitlement; the launcher and Node carry the identifier `sh.localbox.cli`. Nothing under
// `Resources/guest-agent` is signed: the bundle seals those bytes as they are, so their digests stay the ones in
// `agent-version.json`.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CLI_IDENTIFIER = "sh.localbox.cli";
export const ENTITLEMENTS = join(root, "apps/macos/HostDaemon/Resources/localbox-hostd.entitlements");
/** The files a signature must leave exactly as built. */
export const SEALED = "Contents/Resources/guest-agent";
const MACH_O = /^(cafebabe|bebafeca|feedface|cefaedfe|feedfacf|cffaedfe)$/;

const codesign = (args) => {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`codesign ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stderr;
};

/** Every Mach-O file and nested bundle under `app` (inner bundles before the ones holding them, the app last), skipping the sealed folder. */
function codeIn(app) {
  const executables = [], bundles = [], sealed = join(app, SEALED);
  const visit = (path) => {
    if (path === sealed) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      // `app` itself is the outer bundle whatever its folder is called (the assembler signs it under a staging name).
      if (path === app || /\.(app|xpc|framework)$/.test(path)) bundles.push(path);
    } else if (info.isFile() && info.size >= 4 && MACH_O.test(readFileSync(path).subarray(0, 4).toString("hex"))) executables.push(path);
  };
  visit(app);
  return { executables, bundles };
}

/** Signs `app` with `identity` (a SHA-1, a name, or "-" for ad hoc), from `keychain` when given, then verifies it. */
export function signApp(app, { identity, keychain }) {
  const contents = join(app, "Contents");
  const identifiers = new Map([[join(contents, "Resources/bin/localbox"), CLI_IDENTIFIER], [join(contents, "Resources/node/bin/node"), CLI_IDENTIFIER]]);
  const entitled = join(contents, "MacOS/localbox-hostd");
  const { executables, bundles } = codeIn(app);
  for (const path of [...executables, ...bundles]) {
    codesign(["--force", "--sign", identity, ...(keychain ? ["--keychain", keychain] : []), "--timestamp=none",
      ...(identifiers.has(path) ? ["--identifier", identifiers.get(path)] : []), ...(path === entitled ? ["--entitlements", ENTITLEMENTS] : []), path]);
  }
  for (const path of executables) codesign(["--verify", "--strict", path]);
  codesign(["--verify", "--deep", "--strict", app]);
  return executables.map((path) => relative(app, path));
}

/** A PKCS#12 file's bytes; the release keeps its identity as base64 text. */
function p12Bytes(p12) {
  const raw = readFileSync(p12), text = raw.toString("utf8").trim();
  return /^[A-Za-z0-9+/=\s]+$/.test(text) ? Buffer.from(text, "base64") : raw;
}

/** The SHA-1 and SHA-256 fingerprints (lowercase hex, no colons) and common name of the certificate in a binary PKCS#12. */
function fingerprints(binaryP12, password) {
  const certificate = execFileSync("openssl", ["pkcs12", "-in", binaryP12, "-clcerts", "-nokeys", "-passin", "stdin"], { input: `${password}\n`, stdio: ["pipe", "pipe", "ignore"] });
  const fingerprint = (algorithm) => execFileSync("openssl", ["x509", "-noout", "-fingerprint", `-${algorithm}`], { input: certificate, encoding: "utf8" }).replace(/.*=/, "").replaceAll(":", "").trim().toLowerCase();
  const subject = execFileSync("openssl", ["x509", "-noout", "-subject", "-nameopt", "multiline"], { input: certificate, encoding: "utf8" });
  return { sha1: fingerprint("sha1"), sha256: fingerprint("sha256"), name: /commonName\s*=\s*(.*)/.exec(subject)?.[1].trim() };
}

/**
 * The certificate of a PKCS#12 identity (`p12` binary or base64 text, its password in `passwordFile`), as
 * `.release-signing/public.json` records it: `sha1`, `sha256` and its common name `name`. The release's validation
 * checks the identity with this before anything is built.
 */
export function certificateOf({ p12, passwordFile }) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-identity-")));
  try {
    const binary = join(scratch, "identity.p12");
    writeFileSync(binary, p12Bytes(p12), { mode: 0o600 });
    return fingerprints(binary, readFileSync(passwordFile, "utf8").trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs `action({ identity, keychain })` with the PKCS#12 identity in a disposable keychain, then deletes it. The keychain
 * is never added to the search list or made the default; codesign is handed it with `--keychain`.
 */
export async function withIdentity({ p12, passwordFile, sha1 }, action) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "localbox-signing-")));
  const keychain = join(scratch, "signing.keychain-db"), identityFile = join(scratch, "identity.p12");
  const keychainPassword = randomBytes(24).toString("hex");
  const security = (...args) => execFileSync("security", args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    writeFileSync(identityFile, p12Bytes(p12), { mode: 0o600 });
    const password = readFileSync(passwordFile, "utf8").trim();
    const identity = fingerprints(identityFile, password).sha1;
    if (sha1 && identity !== sha1.toLowerCase()) throw new Error(`the signing identity ${identity} is not the pinned one (${sha1})`);
    security("create-keychain", "-p", keychainPassword, keychain);
    security("set-keychain-settings", keychain);
    security("unlock-keychain", "-p", keychainPassword, keychain);
    security("import", identityFile, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign");
    security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain);
    return await action({ identity, keychain });
  } finally {
    try { security("delete-keychain", keychain); } catch { /* never created */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const app = process.argv[2];
  if (!app || app.startsWith("--")) { process.stderr.write("usage: sign.mjs APP (--identity ID [--keychain PATH] | --p12 FILE --password-file FILE [--sha1 HEX])\n"); process.exit(2); }
  const p12 = argument("--p12");
  if (p12) await withIdentity({ p12, passwordFile: argument("--password-file"), sha1: argument("--sha1") }, (identity) => signApp(app, identity));
  else if (argument("--identity")) signApp(app, { identity: argument("--identity"), keychain: argument("--keychain") });
  else { process.stderr.write("sign.mjs needs --identity or --p12\n"); process.exit(2); }
  process.stdout.write(`signed ${app}\n`);
}
