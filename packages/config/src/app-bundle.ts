import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The release's bundle id: the only build whose state is this Mac's real install. */
export const RELEASE_BUNDLE_ID = "sh.localbox.mac";
/** The development build's bundle id (its own TCC grants, no update feed, its own machine root). */
export const DEV_BUNDLE_ID = "sh.localbox.mac.dev";

/** The Localbox.app this code runs inside: the bundle's path and its `CFBundleIdentifier`. */
export interface AppBundle { path: string; id: string | null }

const BUNDLED = /^(.*\.app)\/Contents\/Resources\/cli\//;

/**
 * The app bundle around `file` (by default this module's own realpath), or null for a checkout or the old install.
 * Inside the app the CLI is `<X>.app/Contents/Resources/cli`, and every compiled module sits under it, so any of
 * them finds the same bundle. Never from the environment: a CLI started by another copy's CLI still knows its own app.
 */
export function appBundle(file: string = fileURLToPath(import.meta.url)): AppBundle | null {
  const path = BUNDLED.exec(`${realpathSync(dirname(file))}/`)?.[1];
  return path ? { path, id: bundleId(path) } : null;
}

/** The assembler writes Info.plist as XML (apps/macos/App/scripts/build-app.mjs), so one key is read without a plist parser. */
function bundleId(app: string): string | null {
  try {
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(app, "Contents/Info.plist"), "utf8"))?.[1] ?? null;
  } catch { return null; }
}

let own: AppBundle | null | undefined;
/** `appBundle()` for this process, read once. */
export const thisAppBundle = (): AppBundle | null => own === undefined ? (own = appBundle()) : own;
