import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

/** The agent installation procedure, whose shell blocks tests and probes run exactly as written. */
export const INSTALLATION = "skills/localbox/references/installation.md";
const PINNED = /(cat > release-public\.pem <<'EOF'\n)([\s\S]*?)(EOF\n)/;

/** The procedure's `sh` block under each numbered step (`## 2. Download the release` is step 2). */
export function installationSteps(root: string): Map<number, string> {
  const steps = new Map<number, string>();
  let step = 0;
  for (const part of readFileSync(join(root, INSTALLATION), "utf8").split(/^(## .*)$/m)) {
    const heading = /^## (\d+)\./.exec(part);
    if (heading) { step = Number(heading[1]); continue; }
    const block = /```sh\n([\s\S]*?)```/.exec(part)?.[1];
    if (block && step && !steps.has(step)) steps.set(step, block);
  }
  return steps;
}

/** The public key the procedure pins. */
export const pinnedKey = (steps: Map<number, string>): string | undefined => PINNED.exec(steps.get(3) ?? "")?.[2];
/** Step 3 trusting `pem` instead of the pinned key: how a scratch release, signed with a scratch key, is checked. */
export const trusting = (step: string, pem: string): string => step.replace(PINNED, (_, open, _key, close) => `${open}${pem}${close}`);

/** Serves the files of `dir` over HTTP on 127.0.0.1, as GitHub's `releases/latest/download/NAME` serves a release. */
export async function serveRelease(dir: string): Promise<{ url: string; close(): void }> {
  const server = createServer((request, response) => {
    const path = join(dir, basename(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname)));
    if (!existsSync(path)) { response.writeHead(404).end(); return; }
    response.writeHead(200); createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

/** Runs procedure blocks one after another in `sh`, as an agent would, each in its own shell; stops at the first failure. */
export async function runSteps(blocks: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  let output = "";
  for (const block of blocks) {
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn("/bin/sh", ["-c", block], { env, stdio: ["ignore", "pipe", "pipe"] });
      let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("close", (code) => resolve({ code: code ?? 1, output: text }));
    });
    output += result.output;
    if (result.code !== 0) return { code: result.code, output };
  }
  return { code: 0, output };
}
