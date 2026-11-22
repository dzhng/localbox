import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "./build.mjs";
import { agentPrompt } from "./content.mjs";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

function site(source = readme) {
  const out = mkdtempSync(join(tmpdir(), "localbox-site-"));
  build({ out, siteUrl: "https://localbox.example/", readme: source });
  return { read: (name) => readFileSync(join(out, name), "utf8"), exists: (name) => existsSync(join(out, name)) };
}

test("the page carries the README's install prompt and llms.txt is what it points to", () => {
  const { read } = site();
  assert.ok(readme.includes(`> ${agentPrompt}`));
  assert.ok(read("index.html").includes(agentPrompt));
  assert.ok(agentPrompt.endsWith("/llms.txt"));
  assert.match(read("llms.txt"), /\[agent installation procedure\]\(https:\/\/github\.com\/dzhng\/localbox\/blob\/main\/skills\/localbox\/references\/installation\.md\)/);
});

test("the build refuses a README whose install prompt drifted", () => {
  assert.throws(() => site(readme.replace("https://localbox.sh/llms.txt", "https://wrong.example/install")), /agentPrompt/);
});

test("the product page is canonical, sitemapped and crawler-readable", () => {
  const { read } = site();
  const page = read("index.html");
  assert.match(page, /<meta name="robots" content="index, follow">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/localbox\.example\/">/);
  assert.match(page, /<meta property="og:image" content="https:\/\/localbox\.example\/og\.png">/);
  assert.match(read("sitemap.xml"), /<loc>https:\/\/localbox\.example\/<\/loc>/);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/localbox\.example\/sitemap\.xml/);
});

test("every referenced asset ships with the build", () => {
  const { read, exists } = site();
  const page = read("index.html");
  const assets = [...page.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map((match) => match[1]).filter((path) => path !== "/" && !path.startsWith("/_vercel"));
  assert.ok(assets.some((path) => path.startsWith("/art/")));
  for (const path of assets) assert.ok(exists(path.slice(1)), `missing ${path}`);
});

test("illustrations reserve their layout and carry alt text", () => {
  const page = site().read("index.html");
  for (const [img] of page.matchAll(/<img [^>]+>/g)) {
    assert.match(img, /alt="[^"]{10,}"/);
    assert.match(img, /width="\d+" height="\d+"/);
  }
});

test("the landing page offers agent actions instead of a browser download", () => {
  const page = site().read("index.html");
  assert.match(page, /claude-cli:\/\/open\?/);
  assert.match(page, /codex:\/\/new\?/);
  assert.doesNotMatch(page, /Download for Mac|\.dmg/);
});

test("the not-found page is not indexed and has no view switch", () => {
  const missing = site().read("404.html");
  assert.match(missing, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(missing, /data-set-mode/);
  assert.doesNotMatch(missing, /rel="canonical"/);
});

test("the update feed's permanent address sends Sparkle to the latest release's appcast", () => {
  const { redirects } = JSON.parse(readFileSync(new URL("./vercel.json", import.meta.url), "utf8"));
  // The URL every installed app carries (apps/macos/App/scripts/build-app.mjs); it may never change once an app ships.
  const feed = /const FEED_URL = "([^"]+)"/.exec(readFileSync(new URL("../macos/App/scripts/build-app.mjs", import.meta.url), "utf8"))[1];
  assert.equal(feed, "https://localbox.sh/mac/appcast.xml");
  const rule = redirects.find((redirect) => redirect.source === new URL(feed).pathname);
  assert.deepEqual(rule, { source: "/mac/appcast.xml", destination: "https://github.com/dzhng/localbox/releases/latest/download/appcast.xml", statusCode: 302 });
  assert.ok(redirects.indexOf(rule) > redirects.findIndex((redirect) => redirect.has?.[0]?.value === "www.localbox.sh"), "www.localbox.sh still goes to the apex first");
});

test("llms.txt sells and installs; usage lives in the skill", () => {
  const llms = site().read("llms.txt");
  assert.match(llms, /installation procedure/);
  assert.match(llms, /Localbox skill/);
  assert.doesNotMatch(llms, /pre-release|operation_uncertain|mutation|localbox (vm|shell|auth|mcp) /);
});
