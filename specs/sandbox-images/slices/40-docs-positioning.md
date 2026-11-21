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
site built at `dfa1d49`, `pre-critique/` this slice's first rewrite (what the
critique below started from), `after/` the final site, `crops/` the zooms the
critique read, `compare-metrics.json` before→pre-critique and
`compare-metrics-critique.json` pre-critique→after. Dark-scheme captures were
pixel-identical to light (the site has no dark theme), so only light is kept.
Shots are taken after fonts, every image decode and transitions settle; `after/`
adds features at mobile and tablet and a mixed open/closed FAQ.

- compare-screenshots, before→pre-critique: every pair moved by copy only
  (distance 0.05–0.21); no layout regressions. Pre-critique→after: movement sits
  where the fixes are: the mobile hero (stacked art, 0.19), desktop features
  (trimmed drawings, new headings, 0.12), mobile compare and FAQ (copy, icon,
  0.07–0.08); everything else under 0.04. Edge density rises wherever a drawing
  got larger and no frame is empty. Verdict: candidate accepted.
- screenshot-critique, by one fresh agent that saw only the shots and the
  intended message (re-run on each recapture through the same agent):
  - Round 1 failed. Should-fix: "A sandbox, not your whole computer" over a
    body opening "Each sandbox is a whole computer"; feature-drawing labels at
    4–6 px on phones; FAQ answers that contradicted shared folders or pointed at
    an unlinked security model; jargon (bounded, host folder, operation catalog,
    roomiest, least recently used). All fixed.
  - Round 2 failed on the share-a-folder drawing's labels on phones (5–6 px).
    Fixed with a phone cut.
  - Round 3: **pass with nits only** for layout and copy. Its remaining nits:
    mobile drawings run within about 10 px of the screen edge, a one-word last
    line in two FAQ answers, "MCP" unexplained, the relay answer's honesty
    "may worry", the bare "Free." bullet in `llms.txt`, "already own" four
    times, the asks cards' speech-bubble corner, tight mobile table headers.
    Left as is.
  - Its two should-fix items are **art direction**, open for human review: the
    black character plays a different role in each drawing (digger, courier,
    the agent in the jar, the relay climber, two of them in share-a-folder)
    and the agent is drawn three ways; the hero's sandbox is a tray of sand
    beside the computers rather than one of them, with the wordmark under the
    curve possibly reading as its label. Both need new drawings, not edits.
- Human review: not held for (this pass was told not to stop); the shots are in
  the evidence folder.

**Gates.** Green after the critique fixes: `tests/skill-commands.test.ts` (3),
`apps/site/build.test.mjs` (8), `npm run site:build`, `npm run build`, `npm test`
(277). `npm run proof -- --through 39 --tier u,l` was not run (no product code
changed; only the site, docs and art).

**Spec gaps.**

- This branch's release daemon still answers `image copy` `unsupported` (the
  `ImageTransfer` adapter is on another branch), and the macOS base build
  (slice 34) is on another branch. The docs describe the launch product as the
  slice asks; the skill names only commands the CLI has, but those two fail on a
  release built from this branch alone.
- Marketing still describes shared folders, which `SECURITY.md` says are not
  built; unchanged here.
