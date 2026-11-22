/**
 * Release versions: `MAJOR.MINOR.PATCH` with an optional `-prerelease` suffix (`1.2.0-rc.1`), ordered as SemVer orders
 * them, which is also how Sparkle's comparator orders them (a suffix sorts before the plain version). The tag is
 * `v<version>`; a suffixed version is published as a GitHub prerelease, so `releases/latest` (what installs and the
 * update feed follow) never moves to it.
 */

export interface Version { major: number; minor: number; patch: number; prerelease: Array<string | number> }

const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): Version | undefined {
  const match = PATTERN.exec(text);
  if (!match) return undefined;
  const prerelease = match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : [];
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Both must parse. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`not a release version: ${!x ? a : b}`);
  for (const key of ["major", "minor", "patch"] as const) if (x[key] !== y[key]) return x[key] - y[key];
  // A version without a suffix is newer than any prerelease of it.
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let index = 0; index < Math.max(x.prerelease.length, y.prerelease.length); index++) {
    const [p, q] = [x.prerelease[index], y.prerelease[index]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    // Numeric identifiers sort before alphanumeric ones.
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version: string): boolean => (parseVersion(version)?.prerelease.length ?? 0) > 0;

export const tagOf = (version: string): string => `v${version}`;

/** The newest version among `tags` (`v1.2.3` gives `1.2.3`); tags that name no release version are ignored. */
export function newestVersion(tags: string[]): string | undefined {
  const versions = tags.filter((tag) => tag.startsWith("v") && parseVersion(tag.slice(1))).map((tag) => tag.slice(1));
  return versions.sort(compareVersions).at(-1);
}
