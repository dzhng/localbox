---
name: release
description: Publish a Localbox release and keep the agent-installed CLI and skill update path working.
---

# Localbox release

Use this skill when the user asks to publish Localbox or repair its release
installation. The tagged workflow and `scripts/release.sh` own packaging; do
not create a browser download flow or a second installer.

1. Pull the current source and tags, inspect the release diff, and keep the
   source tree clean before packaging.
2. On Apple Silicon, build the signed app and CLI with `scripts/release.sh`.
   The CLI archive must contain the bundled ARM64 Node runtime, the Localbox
   skill, the pinned `skills@1.7.0` installer, and the release scripts.
3. Verify the manifest signature and checksums, then install from a relocated
   scratch directory with `scripts/install-release.sh`. Exercise `localbox
   skill install` there with a poisoned `npx`/`npm` path to prove the release
   uses its bundled installer.
4. Only after the local smoke passes should the tag workflow publish the app,
   CLI, `release.json`, and `SHA256SUMS` to GitHub Releases.
5. Verify the public tag and assets. The agent installation procedure in the
   bundled Localbox skill consumes that tagged kit and invokes the installer;
   users do not download or drag an app from a browser.

Release credentials live in the checkout's git-ignored `.release-signing/`
(see DEVELOPMENT.md); restore it from the owner's Obsidian backup
(`dev/localbox/release-signing/`), never regenerate it. A new manifest key would
strand every installed copy, and `release.sh` refuses one that does not match
`skills/localbox/release-public.pem`. That public key is the pinned trust root,
printed in the installation procedure for first installs; a public key copied
from the manifest being verified is never trusted.
