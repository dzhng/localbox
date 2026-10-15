# 14 Agent setup: the skill and CLI stay installed and current

**Unlocks:** after `install-release.sh`, every agent harness on the Mac has the
Localbox skill and the `localbox` command, and both always match the installed
release, the way Yap's app keeps its skill and CLI current
(`~/dev/screen-recorder/skills/yap/references/skill-lifecycle.md`, "App and CLI
lifecycle operations"). The skill is the only usage reference agents get;
`llms.txt` only sells and installs (plan decision D16).

## Seam

- Catalog operations (executor `host`), so the CLI and MCP see the same thing:
  `skill.status`, `skill.install`, `skill.update`, `skill.uninstall`,
  `cli.status`, `agents.setup.status`, `agents.setup.set {enabled}`. They wrap the
  existing `apps/cli/src/skill-manager.ts` (bundled `skills@1.7.0` installer and
  bundled `skills/localbox`, no host Node or network); the CLI's hand-written
  `skill` branch goes. States stay `installed | updating | missing | unmanaged |
  disabled | needs_attention`; `skill.status` adds `source_revision` (the release
  version that wrote it) and the ownership receipt path.
- One maintenance setting, **agent setup**, on by default, persisted under
  `machinePaths().root` (slice 00). While on, Localbox owns the global
  `localbox` skill and the `~/.local/bin/localbox` link and may replace an
  existing global copy (backed up first, as today). While off, nothing touches
  them, so a user can customise the skill; `skill.uninstall` with setup on is
  undone at the next reconcile, and the result says so (P1).
- One reconcile function owns "make the skill and CLI match this release". It
  runs from exactly three places: the end of `install-release.sh` (already
  calls `skill install`; becomes the reconcile), the daemon's start (which is
  every launch, including the relaunch after each update), and an explicit
  `skill.install`/`skill.update`. The updater's separate `refreshManagedSkill`
  path is deleted; there is no periodic timer for the skill.
- Results follow P1: what was installed, replaced, backed up (path) or left
  alone, and why.
- `skills/localbox/SKILL.md` and its references are rewritten for the shipped
  product of slices 06–12 (sign-in, sandboxes, placement, sleep, results), with
  `references/installation.md` (agent install from a signed release),
  `references/skill-lifecycle.md` (status, maintenance, manual pinned install for
  project scope or comparison, modelled on Yap's) and a capability-discovery
  reference pointing at `localbox help`. The install reference tells agents not
  to run `npx skills add` or copy the skill themselves.

## See it

`npm run proof -- 14 --tier u,l` with a fake `HOME` per machine root:

- Fresh install (`install-release.sh` in fixture mode): `skill.status` is
  `installed`, `managed: true`, `source_revision` = the release version, and every
  harness discovery path has `SKILL.md`.
- A pre-existing hand-copied skill is backed up and replaced while setup is on.
- Simulated update to a new release version: after the daemon restarts,
  `source_revision` changes with no other action.
- `agents.setup.set {enabled:false}`, then edit the skill: a daemon restart leaves
  it untouched and `skill.status` reports `unmanaged`.
- `skill.uninstall` with setup on: the next reconcile reinstalls it, and both
  results say so.
- The same operations through MCP `tools/call` return identical results.

## Gates

`tests/skill-manager.test.ts` extended (reconcile, maintenance off, revision);
new `tests/agent-setup.test.ts`; `tests/skill-commands.test.ts` (slice 13) covers
the rewritten skill.

## Delegated

Where the setting file lives under the machine root; text layout of results.

## Feedback that would change it

Wanting a periodic refresh in addition to launch-time reconcile; making setup
opt-in.
