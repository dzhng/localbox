// `npm run proof -- <NN|all> [--through NN] [--tier u,s,l,v,x] [--keep]`: one JSON verdict line per
// slice probe. Exit 0 when every check passes, 2 when a failure is only a missing external input
// ("blocked: …"), 1 otherwise.
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface Check { name: string; ok: boolean; ms: number; detail?: string }
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ProofContext {
  root: string;
  evidence: string;
  tier: string;
  keep: boolean;
  check(name: string, run: () => Promise<unknown> | unknown): Promise<Check>;
  exec(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ExecResult>;
  stack(command: "up" | "down" | "status", machines?: string[]): Promise<ExecResult>;
}
export interface Probe { id: string; tiers: string[]; run(ctx: ProofContext): Promise<Check[]> }

const root = resolve(new URL("../..", import.meta.url).pathname);
const probesDir = join(root, "scripts/proof/probes");
const flag = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const target = process.argv.slice(2).find((value, index, values) => !value.startsWith("--") && !["--tier", "--through"].includes(values[index - 1]));
const through = flag("--through");
const tiers = (flag("--tier") ?? "u").split(",").filter(Boolean);
const keep = process.argv.includes("--keep");

function exec(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function probeFiles(): Promise<Map<string, string>> {
  const files = (await readdir(probesDir)).filter((file) => /^\d\d-.*\.ts$/.test(file)).sort();
  return new Map(files.map((file) => [file.slice(0, 2), join(probesDir, file)]));
}

async function runProbe(id: string, file: string): Promise<{ ok: boolean; blocked: boolean }> {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const evidence = join(root, ".localbox/proof/runs", `${stamp}-${id}`); await mkdir(evidence, { recursive: true });
  const probe = (await import(file)) as Probe; const checks: Check[] = []; const started = Date.now();
  for (const tier of tiers) {
    if (!probe.tiers.includes(tier)) continue;
    const ctx: ProofContext = {
      root, evidence, tier, keep, exec,
      stack: (command, machines = []) => exec("npx", ["tsx", "scripts/proof/stack.ts", command, ...(machines.length ? ["--machines", machines.join(",")] : [])]),
      check: async (name, fn) => { const at = Date.now(); try { await fn(); return { name, ok: true, ms: Date.now() - at }; } catch (error) { return { name, ok: false, ms: Date.now() - at, detail: detail(error) }; } },
    };
    try { checks.push(...await probe.run(ctx)); } catch (error) { checks.push({ name: `tier ${tier}`, ok: false, ms: Date.now() - started, detail: detail(error) }); }
  }
  if (!checks.length) checks.push({ name: "tiers", ok: false, ms: 0, detail: `probe ${id} implements none of ${tiers.join(",")} (has ${probe.tiers.join(",")})` });
  const verdict = { slice: id, tier: tiers.join(","), ok: checks.every((check) => check.ok), ms: Date.now() - started, checks, evidence };
  await writeFile(join(evidence, "verdict.json"), `${JSON.stringify(verdict)}\n`);
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  const failed = checks.filter((check) => !check.ok);
  return { ok: verdict.ok, blocked: failed.length > 0 && failed.every((check) => /^blocked:/i.test(check.detail ?? "")) };
}

const files = await probeFiles();
const selected = [...files.keys()].filter((id) => target === "all" || (through ? id <= through.padStart(2, "0") : id === (target ?? "").padStart(2, "0")));
if (!selected.length) { process.stderr.write(`no proof probe matches ${target ?? `--through ${through}`}; available: ${[...files.keys()].join(", ")}\n`); process.exit(2); }
const results = [];
for (const id of selected) results.push(await runProbe(id, files.get(id)!));
process.exitCode = results.every((result) => result.ok) ? 0 : results.every((result) => result.ok || result.blocked) ? 2 : 1;
