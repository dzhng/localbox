import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "./build.mjs";
import { agentPrompt } from "./content.mjs";

function files(readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8")) {
  const out = mkdtempSync(join(tmpdir(), "localbox-site-"));
  build({ out, siteUrl: "https://localbox.example", readme });
  return (name) => readFileSync(join(out, name), "utf8");
}

test("the page and llms.txt carry the same agent install prompt", () => {
  const read = files();
  assert.ok(read("index.html").includes(agentPrompt));
  assert.ok(read("llms.txt").includes(agentPrompt));
});

test("the indexed product page is canonical, sitemapped and crawler-readable", () => {
  const page = files()("index.html");
  assert.match(page, /<meta name="robots" content="index, follow">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/localbox\.example\/">/);
  assert.match(files()("sitemap.xml"), /<loc>https:\/\/localbox\.example\/\<\/loc>/);
  assert.match(files()("robots.txt"), /Sitemap: https:\/\/localbox\.example\/sitemap\.xml/);
});

test("the landing page offers agent actions instead of a browser download", () => {
  const page = files()("index.html");
  assert.match(page, /claude-cli:\/\/open\?/);
  assert.match(page, /codex:\/\/new\?/);
  assert.match(page, /href="https:\/\/github\.com\/dzhng\/agent-computer#agent-setup"/);
  assert.doesNotMatch(page, /Download for Mac|api\.github\.com/);
});

test("the build refuses a README without the agent install prompt", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.throws(() => files(readme.replace("https://localbox.sh/llms.txt", "https://wrong.example/install")), /agent install prompt/);
});
