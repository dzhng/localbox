# Localbox website

The public site at [localbox.sh](https://localbox.sh): one indexed product page
for humans, and the same instructions as plain text at `/llms.txt` for agents.

## Principles

- **One copy source.** [content.mjs](content.mjs) holds every word. The page,
  its agent view and `llms.txt` all render from it, so humans and agents can't
  be told different things.
- **The README owns the install prompt.** The build fails if `agentPrompt`
  differs from the prompt quoted in the repository README. Change both together.
- **Link, don't restate.** The install procedure belongs to the consumer skill's
  references. `llms.txt` keeps only what changes an agent's first move and links
  the rest.
- **Artwork has one home.** Illustrations live in `.github/readme` and are copied
  to `/art` at build time; the build reads their PNG size so images reserve
  layout. `og.png` is the 1200×630 social card cut from the header art.
- **No dependencies, no framework.** [build.mjs](build.mjs) writes static files to
  `dist/`, including `404.html`, `robots.txt` and `sitemap.xml`. There is no
  download button: agents are the only install route, and the Open in Claude Code
  / Open in Codex links only pre-fill the prompt.

## Build and check

```sh
npm run site:build   # writes apps/site/dist
npm run site:test
```

Preview `apps/site/dist` with any static server. Canonical URLs, the sitemap and
robots use `SITE_URL`, else Vercel's production domain, else a local origin.

## Deploying on Vercel

Configure the project with Root Directory `apps/site` and enable "Include files
outside the root directory", because the build reads the README and artwork.
[vercel.json](vercel.json) supplies the build, the `www` redirect, security
headers and the `llms.txt` content type. Set `SITE_URL` to the production origin.
