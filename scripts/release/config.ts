import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The public repository whose GitHub Releases installs and updates download from. */
export const REPOSITORY = "dzhng/localbox";
/** The app's asset name; the installation procedure downloads it from `releases/latest/download/`. */
export const ZIP = "Localbox-macos-arm64.zip";
/** The update feed every installed app reads; apps/site redirects it to the latest release's `appcast.xml`. */
export const FEED_URL = "https://localbox.sh/mac/appcast.xml";
export const BUNDLE_ID = "sh.localbox.mac";
/** The key installers and updates trust, printed in the installation procedure too. */
export const PINNED_PUBLIC_KEY = "skills/localbox/release-public.pem";
export const MINIMUM_MACOS = "14.0";

/** The files of the release signing folder (`.release-signing/`, or `LOCALBOX_SIGNING_DIR`). */
export const SIGNING_FILES = {
  privateKey: { name: "release-private.pem", what: "the Ed25519 key that signs release.json, the zip and the feed" },
  p12: { name: "release-identity.p12", what: "the self-signed code-signing identity" },
  password: { name: "release-identity-password.txt", what: "the identity's password" },
  publicJson: { name: "public.json", what: "the identity's pinned fingerprints" },
} as const;

export interface ReleaseConfig {
  root: string;
  version: string;
  /** package.json's version, which a real release must carry. */
  packageVersion: string;
  /**
   * A rehearsal may run from any branch with uncommitted changes, take a `--version` and scratch credentials
   * (`LOCALBOX_SIGNING_DIR`, `LOCALBOX_RELEASE_PUBLIC_KEY`), and can never publish.
   */
  rehearsal: boolean;
  /** Where `build` writes the release (every file in it is an asset), and its receipt beside it. */
  out: string;
  receipt: string;
  signingDir: string;
  /** The public key the bundle pins and the signatures must verify against: the pinned key, unless rehearsing. */
  publicKey: string;
  /** Set when `LOCALBOX_RELEASE_PUBLIC_KEY` replaces the pinned key. */
  publicKeyOverridden: boolean;
  image?: string;
  imageDigest?: string;
  sparkle: string;
  /** The Node the app bundles (`LOCALBOX_NODE_BIN`), else the one running this. */
  node?: string;
}

export interface Flags { stage?: string; rehearsal: boolean; dryRun: boolean; confirm: boolean; version?: string; out?: string; help: boolean }

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { rehearsal: false, dryRun: false, confirm: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--rehearsal") flags.rehearsal = true;
    else if (argument === "--dry-run") flags.dryRun = true;
    else if (argument === "--confirm") flags.confirm = true;
    else if (argument === "--help" || argument === "-h") flags.help = true;
    else if (argument === "--version" || argument === "--out") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      flags[argument === "--version" ? "version" : "out"] = value;
    } else if (!argument.startsWith("-") && !flags.stage) flags.stage = argument;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (flags.version && !flags.rehearsal) throw new Error("--version is for rehearsals only: a real release carries package.json's version (bump it with npm version X.Y.Z --no-git-tag-version)");
  return flags;
}

export function releaseConfig(root: string, flags: Flags, env: NodeJS.ProcessEnv = process.env): ReleaseConfig {
  const packageVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const out = resolve(root, flags.out ?? "dist/release");
  const override = env.LOCALBOX_RELEASE_PUBLIC_KEY;
  return {
    root, version: flags.version ?? packageVersion, packageVersion, rehearsal: flags.rehearsal,
    out, receipt: `${out}.build.json`,
    signingDir: resolve(root, env.LOCALBOX_SIGNING_DIR || ".release-signing"),
    publicKey: resolve(root, override || PINNED_PUBLIC_KEY), publicKeyOverridden: !!override,
    image: env.LOCALBOX_IMAGE ? resolve(root, env.LOCALBOX_IMAGE) : undefined,
    imageDigest: env.IMAGE_DIGEST || recordedImageDigest(root),
    sparkle: resolve(root, env.LOCALBOX_SPARKLE_FRAMEWORK || "dist/sparkle/Sparkle.framework"),
    node: env.LOCALBOX_NODE_BIN || undefined,
  };
}

/** The digest `npm run image:build` recorded for the full (release) image, when it was built in this checkout. */
function recordedImageDigest(root: string): string | undefined {
  try { return (JSON.parse(readFileSync(join(root, "dist/vm-image/full/manifest.json"), "utf8")) as { digest?: string }).digest; } catch { return undefined; }
}

export const signingFile = (config: ReleaseConfig, file: keyof typeof SIGNING_FILES): string => join(config.signingDir, SIGNING_FILES[file].name);

/** One file of a build, which `publish` uploads as an asset of the same name. */
export interface Asset { name: string; size: number; sha256: string }
/** What `build` records beside its output, so `smoke` and `publish` act on exactly that build. */
export interface BuildReceipt { version: string; commit: string; rehearsal: boolean; publicKeySha256: string; builtAt: string; assets: Asset[] }
