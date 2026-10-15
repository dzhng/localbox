// Renders the static website into dist/ from content.mjs. No dependencies.
// Run `node apps/site/build.mjs`; Vercel runs it with apps/site as the root.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as content from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const artwork = join(here, "../../.github/readme");
const staticFiles = ["style.css", "main.js", "favicon.svg", "og.png"];

/** Production origin: explicit SITE_URL, else Vercel's production domain, else local preview. */
function defaultSiteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : "http://localhost:4173";
}

const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Inline `code` in copy becomes <code>; everything else is escaped. */
const prose = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");

/** The README owns the human-facing prompt too; refuse to publish a different one. */
function checkPromptMatchesReadme(readme) {
  const quoted = readme
    .split("\n")
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2));
  if (!quoted.includes(content.agentPrompt))
    throw new Error(`README "Get started" prompt no longer matches apps/site/content.mjs agentPrompt:\n  ${content.agentPrompt}`);
}

/** Intrinsic PNG size from the IHDR chunk, so images reserve their space before loading. */
function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function illustration(name, alt, { eager = false } = {}) {
  const { width, height } = pngSize(join(artwork, name));
  const loading = eager ? `fetchpriority="high"` : `loading="lazy"`;
  return `<img src="/art/${name}" alt="${escape(alt)}" width="${width}" height="${height}" ${loading} decoding="async">`;
}

const blob = (id) => `<svg class="blob" id="${id}" viewBox="0 0 120 130" aria-hidden="true">
  <path d="M60 6c30 0 52 22 54 58 2 34-18 60-54 60S4 100 6 64C8 28 30 6 60 6z" fill="var(--ink)"/>
  <g class="eyes"><circle cx="44" cy="58" r="8" fill="#fff"/><circle cx="78" cy="58" r="8" fill="#fff"/></g>
</svg>`;

const copyButton = (label, source) =>
  `<button class="copy" type="button" data-copy="${source}"><span class="copy-label">${label}</span><span class="copy-done" aria-live="polite"></span></button>`;

const mark = (yes) =>
  yes
    ? `<span class="yes" role="img" aria-label="yes">✓</span>`
    : `<span class="no" role="img" aria-label="no">✗</span>`;

function head(siteUrl, { title, description, path = "/", indexed = true }) {
  const { meta, links } = content;
  const og = `${siteUrl}/og.png`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Localbox",
    description: meta.description,
    url: `${siteUrl}/`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "Localbox", url: links.repo },
  };
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="robots" content="${indexed ? "index, follow" : "noindex"}">
${indexed ? `<link rel="canonical" href="${siteUrl}${path}">` : ""}
<link rel="alternate" type="text/plain" href="/llms.txt" title="Instructions for AI agents">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Localbox">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="${siteUrl}${path}">
<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escape(meta.imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(title)}">
<meta name="twitter:description" content="${escape(description)}">
<meta name="twitter:image" content="${og}">
<meta name="twitter:image:alt" content="${escape(meta.imageAlt)}">
<meta name="theme-color" content="#ffffff">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Caveat:wght@600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="/style.css">
<script defer src="/_vercel/insights/script.js"></script>
${indexed ? `<script type="application/ld+json">${JSON.stringify(structuredData)}</script>` : ""}`;
}

/** The human/agent switch only appears where both views exist. */
const bar = ({ modeSwitch = true } = {}) => `<header class="bar">
  <a class="brand" href="/" aria-label="Localbox home">${blob("brand-blob")}<span>Localbox</span></a>
  <nav class="nav" aria-label="Sections"><a href="/#how">How it works</a><a href="/#setup">Setup</a><a href="/#faq">FAQ</a></nav>
  ${modeSwitch ? `<div class="mode" role="group" aria-label="Who is reading?">
    <button type="button" data-set-mode="human"><span class="long">I'm a </span>human</button>
    <button type="button" data-set-mode="agent"><span class="long">I'm an </span>agent</button>
  </div>` : ""}
  <a class="gh" href="${content.links.repo}">GitHub</a>
</header>`;

const footer = () => {
  const { links } = content;
  return `<footer class="foot">
  ${blob("foot-blob")}
  <p>Localbox is CLI-first and built in the open on <a href="${links.repo}">GitHub</a>.</p>
  <p class="foot-links"><a href="${links.releases}">Releases</a> · <a href="/llms.txt">llms.txt</a> · <a href="${links.agentSetup}">Agent setup</a> · <a href="${links.security}">Security</a> · <a href="${links.development}">Development</a></p>
</footer>`;
};

function renderPage(siteUrl) {
  const { meta, hero, compare, agentPrompt, requirements } = content;
  return `<!doctype html>
<!-- AI agents: plain-text instructions are at /llms.txt -->
<html lang="en">
<head>
${head(siteUrl, { title: meta.title, description: meta.description })}
<script>document.documentElement.dataset.mode = /[?&#]agent\\b/.test(location.href) || localStorage.getItem("localbox-mode") === "agent" ? "agent" : "human";</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${bar()}

<main class="human-view" id="main">
  <section class="hero">
    <p class="kicker hand">${escape(hero.kicker)}</p>
    <h1>${escape(hero.title)}<br><span>${escape(hero.accent)}</span></h1>
    <p class="lede">${prose(hero.lede)}</p>
    <figure class="hero-art">${illustration("header.png", meta.imageAlt, { eager: true })}</figure>

    <div class="cta">
      <p class="hand cta-label">tell your agent to install it</p>
      <blockquote id="agent-prompt">${escape(agentPrompt)}</blockquote>
      <div class="actions">
        ${content.openIn.map((link) => `<a class="open" href="${escape(link.href)}">${escape(link.label)}</a>`).join("\n        ")}
        ${copyButton("Copy prompt", "agent-prompt")}
      </div>
      <p class="fine">The open buttons type the prompt into your agent without sending it.</p>
      <p class="fine req">${requirements} · pre-release</p>
    </div>
  </section>

  <section class="compare" aria-labelledby="compare-title">
    <h2 id="compare-title">${escape(compare.title)}</h2>
    <p class="section-lede">${prose(compare.body)}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col"><span class="sr">Capability</span></th>${compare.columns.map((column, i) => `<th scope="col"${i === compare.columns.length - 1 ? ' class="us"' : ""}>${escape(column)}</th>`).join("")}</tr></thead>
        <tbody>${compare.rows.map((row) => `<tr><th scope="row">${escape(row.label)}</th>${row.values.map((value, i) => `<td${i === row.values.length - 1 ? ' class="us"' : ""}>${mark(value)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
  </section>

  <section class="asks" aria-labelledby="asks-title">
    <h2 id="asks-title">Things you can just ask</h2>
    <ul>${content.asks.map((ask) => `<li>“${escape(ask)}”</li>`).join("")}</ul>
  </section>

  <section class="features" id="how" aria-labelledby="how-title">
    <h2 id="how-title">How it works</h2>
    ${content.features
      .map(
        (item) => `<article>
      <figure>${illustration(item.image, item.alt)}</figure>
      <div class="feature-copy"><p class="hand feature-kicker">${escape(item.kicker)}</p><h3>${escape(item.title)}</h3><p>${prose(item.body)}</p></div>
    </article>`,
      )
      .join("\n    ")}
  </section>

  <section class="catalog" aria-labelledby="catalog-title">
    <h2 id="catalog-title">What your agent can use</h2>
    <p class="section-lede">One operation catalog, the same from the CLI and from MCP.</p>
    <dl>${content.capabilities.map((item) => `<div><dt>${escape(item.area)}</dt><dd>${prose(item.body)}</dd></div>`).join("")}</dl>
  </section>

  <section class="setup" id="setup" aria-labelledby="setup-title">
    <h2 id="setup-title">Setting it up</h2>
    <div class="columns">
      <div class="for-humans">
        <h3><span class="hand">for</span> humans</h3>
        <ol>${content.humanSteps.map((step) => `<li><strong>${prose(step.title)}</strong><p>${prose(step.body)}</p></li>`).join("")}</ol>
      </div>
      <div class="for-agents">
        <h3><span class="hand">for</span> agents</h3>
        <p>Everything an agent needs is plain text at <a href="/llms.txt">/llms.txt</a>, or flip the switch up top.</p>
        <div class="terminal" role="presentation"><div class="dots"><i></i><i></i><i></i><span>llms.txt</span></div><pre tabindex="0">${escape(content.llmsText())}</pre></div>
      </div>
    </div>
  </section>

  <section class="faq" id="faq" aria-labelledby="faq-title">
    <h2 id="faq-title">Questions</h2>
    ${content.faq.map((item) => `<details><summary>${escape(item.q)}</summary><p>${prose(item.a)}</p></details>`).join("\n    ")}
  </section>
</main>

<main class="agent-view">
  <p class="agent-banner"># You're reading the agent view. Same words as <a href="/llms.txt">/llms.txt</a> ${copyButton("Copy all", "agent-text")}</p>
  <pre id="agent-text">${escape(content.llmsText())}</pre>
</main>

${footer()}
<script type="module" src="/main.js"></script>
</body>
</html>
`;
}

function renderNotFound(siteUrl) {
  return `<!doctype html>
<html lang="en">
<head>
${head(siteUrl, { title: "Not found — Localbox", description: content.meta.description, indexed: false })}
</head>
<body>
${bar({ modeSwitch: false })}
<main class="missing" id="main">
  ${blob("lost-blob")}
  <h1>Nothing here.</h1>
  <p class="lede">This page isn't on the computer. The <a href="/">home page</a> is, and so is <a href="/llms.txt">/llms.txt</a>.</p>
</main>
${footer()}
<script type="module" src="/main.js"></script>
</body>
</html>
`;
}

export function build({ out = join(here, "dist"), siteUrl = defaultSiteUrl(), readme = readFileSync(join(here, "../../README.md"), "utf8") } = {}) {
  checkPromptMatchesReadme(readme);
  const origin = siteUrl.replace(/\/$/, "");
  const images = ["header.png", ...content.features.map((item) => item.image)];
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "art"), { recursive: true });
  writeFileSync(join(out, "index.html"), renderPage(origin));
  writeFileSync(join(out, "404.html"), renderNotFound(origin));
  writeFileSync(join(out, "llms.txt"), content.llmsText());
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
  writeFileSync(
    join(out, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc></url>\n  <url><loc>${origin}/llms.txt</loc></url>\n</urlset>\n`,
  );
  for (const file of staticFiles) copyFileSync(join(here, file), join(out, file));
  for (const image of images) copyFileSync(join(artwork, image), join(out, "art", image));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Built ${build()}`);
