import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The agent-facing docs: every file of the skill, and the README's agent section. */
async function agentDocs(): Promise<Array<{ file: string; text: string }>> {
  const skill = join(process.cwd(), "skills/localbox");
  const files = (await readdir(skill, { recursive: true })).filter((file) => file.endsWith(".md")).map((file) => join(skill, file));
  const docs = await Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
  const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Agent setup"), readme.indexOf("\n## ", readme.indexOf("## Agent setup") + 1));
  assert.ok(section.length > 100, "README.md has an Agent setup section");
  return [...docs, { file: "README.md#agent-setup", text: section }];
}

/** Code in markdown: fenced blocks and inline spans, where commands are written. */
function code(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  return [...fences, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])];
}

/** The command words after each `localbox` (or `~/.local/bin/localbox`): leading lowercase words, up to a flag or placeholder. */
function commands(snippet: string): string[][] {
  const tokens = snippet.split(/\s+/).map((token) => token.replace(/^["'(]+|["')]+$/g, ""));
  const found: string[][] = [];
  tokens.forEach((token, index) => {
    if (token !== "localbox" && !token.endsWith("/.local/bin/localbox")) return;
    const words: string[] = [];
    for (const word of tokens.slice(index + 1)) { if (!/^[a-z][a-z-]*$/.test(word)) break; words.push(word); }
    if (words.length) found.push(words);
  });
  return found;
}

async function help(words: string[], home: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["bin/localbox.js", ...words, "--help"], { env: { ...process.env, HOME: home, LOCALBOX_MACHINE_ROOT: join(home, "machine") } });
    return { code: 0, output: stdout };
  } catch (error) { const failed = error as { code?: number; stderr?: string }; return { code: Number(failed.code ?? 1), output: failed.stderr ?? "" }; }
}

test("every localbox command the skill and the README's agent section name is a real command", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-commands-"));
  const named = new Map<string, string[]>();
  for (const doc of await agentDocs()) for (const snippet of code(doc.text)) for (const words of commands(snippet)) {
    const key = words.join(" "); named.set(key, [...(named.get(key) ?? []), doc.file]);
  }
  assert.ok(named.size >= 20, `found only ${named.size} commands; the extractor is broken`);
  const unknown: string[] = [];
  const queue = [...named.keys()];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const result = await help(key.split(" "), home);
      if (result.code !== 0) unknown.push(`localbox ${key} (in ${[...new Set(named.get(key))].join(", ")}): ${result.output.split("\n")[0]}`);
    }
  }));
  assert.deepEqual(unknown, []);
});

test("the check fails on a command that does not exist", async () => {
  const result = await help(["sandboxes", "make"], await mkdtemp(join(tmpdir(), "localbox-skill-commands-")));
  assert.equal(result.code, 2); assert.match(result.output, /unknown command: localbox sandboxes make/);
});

test("commands use the catalog's group name; the old `machines` spelling is not a command", async () => {
  const home = await mkdtemp(join(tmpdir(), "localbox-skill-commands-"));
  assert.equal((await help(["machine", "list"], home)).code, 0);
  const alias = await help(["machines", "list"], home);
  assert.equal(alias.code, 2); assert.match(alias.output, /unknown command: localbox machines list/);
});
