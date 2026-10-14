# Localbox website

The public site is one indexed product page with the same agent instructions
served as `/llms.txt`. `content.mjs` owns the copy; `build.mjs` renders both
surfaces so the installation prompt cannot drift between humans and agents.

The site is a dependency-free static build. Run:

```sh
npm run site:build
npm run site:test
```

Configure the Vercel project with Root Directory `apps/site`, keep the build
command from `vercel.json`, and set `SITE_URL` to the production origin. The
page is indexed and sitemapped; `/llms.txt` is the agent-readable installation
surface. There is no browser download CTA: the page sends an agent to the
verified release installer.
