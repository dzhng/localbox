---
name: release
description: Publish a Localbox release and keep the agent-installed CLI and skill update path working.
---

# Localbox release

Use this skill when the user asks to publish Localbox or repair its release
installation. Releases are built on this Mac with `scripts/release.sh` and
uploaded with `gh release create`; there is no publishing workflow. Do not create
a browser download flow or a second installer: the one install path is the
agent installation procedure, `skills/localbox/references/installation.md`.

1. Pull the current source and tags, inspect the release diff, and keep the
   source tree clean before packaging.
2. Build the full linux image (`npm run image:build -- --out DIR`, needs
   Colima/Docker), then the release with `scripts/release.sh` (see
   DEVELOPMENT.md, "Releasing", for its inputs). It writes the signed app zip,
   with the CLI, its Node, the Localbox skill and the pinned `skills@1.7.0`
   installer inside, the image parts, `release.json` and `SHA256SUMS`.
3. Rehearse before publishing: `npm run proof -- 42 --tier a,v` checks a
   scratch-key release end to end. Then follow the installation procedure
   against the real output, served locally (`LOCALBOX_RELEASE_URL`), in a
   scratch `HOME`: step 3 must print the version, and `localbox skill install`
   must work with a poisoned `npx`/`npm` on PATH, proving the bundled installer
   is used.
4. Only after that passes, push the tag and upload every file in the release
   directory with `gh release create vVERSION dist/release/*`.
5. Verify the public tag and assets: the procedure downloads `release.json`,
   `SHA256SUMS` and the app zip from `releases/latest/download`, so those names
   must be on the latest full release.

Release credentials live in the checkout's git-ignored `.release-signing/`
(see DEVELOPMENT.md); restore it from the owner's Obsidian backup
(`dev/localbox/release-signing/`), never regenerate it, and never use it for a
rehearsal. A new manifest key would strand every installed copy, and
`release.sh` refuses one that does not match `skills/localbox/release-public.pem`.
That public key is the pinned trust root, printed in the installation procedure
for first installs; a public key copied from the manifest being verified is
never trusted.
