import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const DUET_COMMIT = "8f3cb100e016e2627618718675b2617d8b98f2aa";
export const declaredSubstitutions = [
  { from: "google-chrome-stable", to: "chromium", reason: "Google Chrome has no Linux ARM64 build." },
  { from: "x86_64 downloads", to: "ARM64 downloads", reason: "Bun, static-web-server, and KasmVNC use native ARM64 release assets." },
  { from: "boldsoftware/exeuntu", to: "ubuntu:24.04 ARM64", reason: "Duet's private base has no available ARM64 image." },
  { from: "Duet-only services", to: "omitted", reason: "Localbox owns the guest agent and boot unit." },
];

export interface PackageInventory { apt: string[]; pip: string[]; npm: string[] }
const clean = (value: string) => value.replace(/["'`,\\]/g, "").trim();
const packageName = (value: string) => clean(value).replace(/\[.*$/, "").split(/[<>=!~]/, 1)[0].toLowerCase().replace(/_/g, "-");

function words(block: string): string[] {
  return block.split(/\s+/).map(clean).filter((word) => /^[a-z0-9][a-z0-9+_.\-[\]<>!=~]*$/i.test(word));
}

export function parseDuetDockerfile(text: string): PackageInventory {
  const aptBlock = text.match(/apt-get install -y --no-install-recommends([\s\S]*?)&& rm -f \/etc\/systemd/ )?.[1] ?? text.match(/apt-get install -y --no-install-recommends([\s\S]*?)\\n\s*\\s*&& rm -rf \/var\/lib\/apt\/lists/)?.[1] ?? "";
  const pipBlock = text.match(/python3 -m pip install --no-cache-dir --break-system-packages([\s\S]*?)\n\n# General workspace/)?.[1] ?? "";
  const npmBlock = text.match(/npm install -g([\s\S]*?)\n\nRUN mkdir/)?.[1] ?? "";
  return {
    apt: words(aptBlock).map(packageName),
    pip: words(pipBlock).map(packageName),
    npm: words(npmBlock).map(packageName),
  };
}

export function parseLocalboxFullDockerfile(text: string): PackageInventory {
  const start = text.indexOf('if [ "$PROFILE" = full ]');
  const end = text.indexOf("  else", start);
  const branch = start >= 0 && end > start ? text.slice(start, end) : "";
  const aptBlock = branch.match(/apt-get install -y --no-install-recommends([\s\S]*?);/)?.[1] ?? "";
  const npmBlock = text.match(/npm install -g([\s\S]*?); fi/)?.[1] ?? "";
  return { apt: words(aptBlock).map(packageName), pip: [], npm: words(npmBlock).map(packageName) };
}

export function parseRequirements(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*#.*$/, "").trim()).filter(Boolean).map(packageName);
}

export function compareParity(duet: PackageInventory, local: PackageInventory, requirements: string): { ok: boolean; differences: string[] } {
  const differences: string[] = [];
  const expectedApt = new Set(duet.apt);
  const actualApt = new Set(local.apt);
  for (const name of expectedApt) if (!actualApt.has(name)) differences.push(`apt missing: ${name}`);
  for (const name of actualApt) if (!expectedApt.has(name) && !["chromium", "systemd", "systemd-sysv", "systemd-resolved", "linux-image-generic", "initramfs-tools", "socat"].includes(name)) differences.push(`apt extra: ${name}`);
  if (actualApt.has("chromium") && !expectedApt.has("chromium") && !declaredSubstitutions.some((item) => item.to === "chromium")) differences.push("apt substitution chromium is undeclared");
  const expectedPip = new Set(duet.pip); const actualPip = new Set(parseRequirements(requirements));
  for (const name of expectedPip) if (!actualPip.has(name)) differences.push(`pip missing: ${name}`);
  for (const name of actualPip) if (!expectedPip.has(name)) differences.push(`pip extra: ${name}`);
  for (const name of new Set(local.npm)) if (!new Set(duet.npm).has(name)) differences.push(`npm extra: ${name}`);
  for (const name of new Set(duet.npm)) if (!new Set(local.npm).has(name)) differences.push(`npm missing: ${name}`);
  return { ok: differences.length === 0, differences };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
  const [duetText, localText, requirements] = await Promise.all([
    readFile(join(root, "packages/vm-image/duet-reference/Dockerfile"), "utf8"),
    readFile(join(root, "packages/vm-image/Dockerfile.arm64"), "utf8"),
    readFile(join(root, "packages/vm-image/requirements-arm64.txt"), "utf8"),
  ]);
  const duet = parseDuetDockerfile(duetText);
  const local = parseLocalboxFullDockerfile(localText);
  const result = compareParity(duet, { ...local, pip: parseRequirements(requirements) }, requirements);
  if (!result.ok) { console.error(result.differences.join("\n")); process.exitCode = 1; }
  else console.log(JSON.stringify({ ok: true, commit: DUET_COMMIT, substitutions: declaredSubstitutions }));
}
