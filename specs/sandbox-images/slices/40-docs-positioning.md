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
