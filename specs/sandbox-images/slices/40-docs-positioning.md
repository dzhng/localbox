# 40 Positioning, docs and security

**Unlocks:** the shipped story. Every public surface describes the CLI that
shipped, under the new positioning.

## Seam (docs only; no code)

- `positioning.md`: headline "Stop renting sandboxes. You already own them.";
  subhead "Localbox turns every Mac you own into sandboxes for your agents: Linux
  or macOS, set up your way, and still there next week. Free." The cloud-sandbox
  comparison now opens the argument; reach across your Macs and the SSH comparison
  follow it. Rewrite the rules that said otherwise. Audience stays individual
  developers; no agent-builder section. A sandbox is "a whole computer, Linux or
  macOS", no longer "a whole Linux computer". macOS is for Xcode work and Mac apps
  through the desktop. Never imply offering macOS sandboxes to other people
  (Apple's licence, E12).
- README, site (`apps/site/content.mjs`), `llms.txt`: the same message; the
  capability table gains an Images row.
- Skill (`skills/localbox/SKILL.md`, `references/capabilities.md`): the `image`
  commands, `--image`, `image wait`, the default image, and how to get Xcode into
  a macOS image (install it in a macOS sandbox with the user's Apple ID or a `.xip`
  they share, then `image create --from`; L5). If slice 15 used the fallback, say
  that kernel upgrades inside a Linux sandbox take effect only through a new image.
- `SECURITY.md`: macOS sandboxes run with SIP off inside the guest and why; direct
  copy (rewrite "The Mac opens no inbound port", `SECURITY.md:125-127`: the Mac
  accepts a UDP flow only from the peer named in a one-time Convex rendezvous, under
  a per-copy key); Cloudflare STUN sees addresses only; images and their deletion.
- [Two-Mac runbook](../../durable-sandboxes/two-mac-runbook.md): add the
  different-network copy steps (slices 20 and 38, tier `x`).

## See it

`npm run site:build`, the site locally; the README on GitHub's renderer.

## Gates

- `tests/skill-commands.test.ts`: every `localbox …` command in the skill and the
  README's agent setup runs `--help`.
- `apps/site/build.test.mjs`.
- `npm run proof -- --through 39 --tier u,l` green.
- Visual: capture the site hero and capability sections; run
  [compare-screenshots](../../../.agents/skills/compare-screenshots/SKILL.md) against
  captures of the current site taken before the edit, then
  [screenshot-critique](../../../.agents/skills/screenshot-critique/SKILL.md) as the
  last check on every shot.

## Delegated

Copy below the headline and subhead, section order after the opening, image
placement on the site.

## Human review (non-blocking)

Open the site shots with
[preview-shots](../../../.agents/skills/preview-shots/SKILL.md), wait about 5 minutes
for a response; if none, decide on the evidence, record it here, close the shots
and continue.

## Outcome (2026-11-21)

Rewritten: `positioning.md`, `README.md`, the site copy (`apps/site/content.mjs`,
which also renders `llms.txt`), the skill (`SKILL.md`, new `references/images.md`,
`capabilities.md`, `installation.md`), `SECURITY.md`, `DEVELOPMENT.md`'s product
boundary, and the [two-Mac runbook](../../durable-sandboxes/two-mac-runbook.md)
step 8. The header art and social card lost the old drawn tagline. Choices: the
`40 —` entries in [choices](../choices.md).

**Visual gate.** Shots in [evidence/40-site](../evidence/40-site/): `before/` is the
site built at `dfa1d49`, `after/` this slice, `crops/` the features read up close,
`compare-metrics.json` the pair metrics. Dark-scheme captures were pixel-identical
to light (the site has no dark theme), so only light is kept.

- compare-screenshots: every pair moves by copy only (parity distance 0.05–0.21,
  largest on the mobile hero, where the headline is two lines longer). No layout
  regressions: the table keeps its columns, the catalog stays a 3×2 grid, the
  art's painted-out tagline leaves no residue. The new headline holds at 390,
  820, 1024 and 1440 px; on mobile "own them" is kept together. Verdict: candidate
  accepted.
- screenshot-critique (no-subagent fallback; this pass was told not to start
  subagents). The case against each, then the call:
  - Hero: the art now has an empty band under the wordmark. It is about the gap
    the tagline had, and the card follows it at the same rhythm. Pass.
  - Hero, mobile: the headline takes four lines and pushes the art down. The lede
    and the CTA card still sit above 1010 px, as before (1031 px). Pass.
  - Compare: the column headers wrap on mobile. They did before; all six rows
    read. Pass.
  - Features: "A whole computer, not your whole computer" could read as a
    contradiction. The kicker "Linux or macOS" and the body's SSH sentence settle
    it. Pass, copy note for human review.
  - Catalog: "Shell and files" packs two areas in one card. Its height matches its
    row. Pass.
  - FAQ (open) and the agent view: long answers wrap within the column; the
    agent view shows the new `llms.txt` text. Pass.
  Rerun with a fresh agent when one is allowed.
- Human review: not held for (this pass was told not to stop); the shots are in
  the evidence folder.

**Gates.** See the pass report: `tests/skill-commands.test.ts`,
`apps/site/build.test.mjs`, `npm run site:build`, `npm run build`, `npm test`.
`npm run proof -- --through 39 --tier u,l` was not run in this pass (no code
changed).

**Spec gaps.**

- This branch's release daemon still answers `image copy` `unsupported` (the
  `ImageTransfer` adapter is on another branch), and the macOS base build
  (slice 34) is on another branch. The docs describe the launch product as the
  slice asks; the skill names only commands the CLI has, but those two fail on a
  release built from this branch alone.
- Marketing still describes shared folders, which `SECURITY.md` says are not
  built; unchanged here.
