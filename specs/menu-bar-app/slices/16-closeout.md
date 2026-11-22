# 16 · Closeout

Needs every slice before it.

## Contract

The app, CLI, skill, release procedure, proofs and docs describe one
architecture, a real install has been proven and undone, and the spec is ready
to close.

## Work

- **Docs, at their canonical homes:**
  - a new `apps/macos/App/README.md` holding the README's single-owner
    invariants as principles (not a file list), linked from
    `apps/macos/HostDaemon/README.md`;
  - `DEVELOPMENT.md`: the Proofs section gains tier `a`; one pass to remove any
    remaining mention of launchd jobs, release folders or rollback;
  - `SECURITY.md`: what is signed (self-signed identity, not notarized), what
    verifies an install (the pinned key) and an update (the signed appcast),
    that the app opens at login, and that quitting takes the Mac offline;
  - product-facing: `README.md` ("Get started", "Agent setup"), the site
    (`apps/site/content.mjs`) and `llms.txt`: Localbox is a menu bar app your
    agent installs; one sentence on the popover. No new positioning.
  - `skills/localbox/SKILL.md` and its references: a short "the app must be
    running" note with the fact that the CLI starts it by itself.
- **A naming test** (in the style of Bento's `tests/branding.test.mjs`) that
  fails on `org.localbox`, `com.localbox`, `ing.bento`, `Bento`, `launchctl`
  or `releases/active` in shipped sources (allow-list: the guest agent's own
  launchd units and `specs/`).
- **Real-account proof** (Bento's D33 pattern): with the dev-id build and a
  local feed, on the user's own account: install per `installation.md` over
  `ssh localhost`, sign in, create a sandbox, update N to N+1, then undo
  everything and confirm nothing is left (`~/Applications`, the login item,
  `~/.local/bin/localbox`, the PATH block, the skill).
- **Runbook** `specs/menu-bar-app/manual-runbook.md` for the README's open
  verification: logout and shutdown with two sandboxes running, a headless
  Mac after a reboot, and a first install from a published release. Each step
  names the command and what to record.
- **Full sweep:** `npm test`, `npm run build`, `swift test` for both packages,
  `npm run generate:snapshots` with no diff, `npm run proof -- all --tier
  u,s,l,a,v`.
- **Whole-spec review** (the `review` skill: shape, diff, docs), then the
  choices ledger consolidated per `audit-choices`, then `close-spec`.

## What the human can see

The runbook; the final shots from slices 13–15 in one contact sheet under
`evidence/`; the consolidated `choices.md`.

## Verification

The sweep above is green; the naming test passes; the real-account proof's
undo leaves a clean account; `git grep` for the deleted mechanisms is empty
outside `specs/`.

## Delegated to the implementer

Wording of the docs; the contact sheet's layout.

## Must stay green

Everything.

## Feedback that would change this slice

The user running the manual runbook and finding a failure: that reopens the
owning slice (08 for logout and shutdown, 09 for the headless login item)
instead of being patched here.
