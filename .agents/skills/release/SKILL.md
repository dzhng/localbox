---
name: release
description: Publish a Localbox release and keep the agent-installed CLI and skill update path working.
---

# Localbox release

Use this skill when the user asks to publish Localbox or repair its release
installation. A release is cut on this Mac with `npm run release -- <stage>`;
there is no publishing workflow. [DEVELOPMENT.md, "Releasing"](../../../DEVELOPMENT.md#releasing)
is the runbook: the checklist, what each stage guarantees, the inputs, failures
and withdrawing. Do not create a browser download flow or a second installer:
the one install path is the agent installation procedure,
`skills/localbox/references/installation.md`.

1. On `main`, pull the source and tags and read the diff since the last
   release. Bump the version with `npm version X.Y.Z --no-git-tag-version`,
   commit and push it (ask the user for the version).
2. `npm run release -- validate` and fix what each refusal says. Missing
   credentials: copy the owner's backup folder in as `.release-signing/`.
   Sparkle: `npm run sparkle:build`. The linux image needs Docker: ask before
   `colima start --arch aarch64`, then `npm run image:build -- --out DIR` and
   `LOCALBOX_IMAGE=DIR`.
3. `npm run release -- test`, `build`, then `smoke`, in order; each stops on
   the first problem and prints the next command.
4. `npm run release -- publish` uploads a DRAFT and checks every asset. Show
   the user the draft's URL and the assets, and run
   `npm run release -- publish --confirm` only when they say to publish: that
   makes it public, and installs and updates follow it within the hour.
5. If a published release is bad, the fix is the next version (Sparkle only
   moves forward); meanwhile move `latest` back as "Withdrawing a release"
   says.

Release credentials live in the checkout's git-ignored `.release-signing/`,
restored from the owner's offline backup. Never regenerate them, never read or
copy them beyond restoring that folder and running the stages, and never use them for a rehearsal: a new
manifest key would strand every installed copy, and `validate` refuses one that
does not match `skills/localbox/release-public.pem`. That public key is the
pinned trust root, printed in the installation procedure for first installs; a
public key copied from the manifest being verified is never trusted. To try the
process, use `--rehearsal` with scratch credentials ("Rehearsing a release"),
which can never publish.
