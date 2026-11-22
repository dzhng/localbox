# Menu bar app

Localbox ships as a Mac menu bar app, `Localbox.app`, with the `localbox` CLI
inside it. An agent installs it with no user action. The app supervises the VM
daemon and the connector, shows this Mac's sandboxes and images in a popover,
and updates itself with Sparkle. It replaces today's install outright: the
versioned release folders, the three launchd jobs, the installer, the updater
job and rollback all go.

The interview record, with every user decision and the Bento reference digest,
is [brief.md](brief.md). Read it before any slice.

## Next Agent Prompt

**Status (2026-11-22):** planned, nothing built. The id rename
(`com.localbox.*` → `sh.localbox.*`) is already committed (a45a38f).

**You are picking this up at slice 01.** Run the spikes first: 01, 02, 03 and
04 have no dependencies and can run in parallel; 05 needs 02 and 03. Record each
verdict in `spikes.md` in this folder (command, evidence, go or no-go) and put
evidence files under `evidence/`. Do not start a build slice whose spike has no
recorded go.

**Warnings**

- **Slice 02 is a kill switch.** If VMs cannot boot, hibernate and restore under
  an app-supervised child, decision 1 in the brief is dead. Stop and return to
  the user with the evidence. There is no silent fallback.
- Slice 01's and 05's fallbacks that add a launchd job, a second updater or a
  new signing key need the user's sign-off. Stop and ask.
- This worktree has no `.release-signing/`. Nothing before slice 10 needs it;
  spikes use scratch keys and a scratch identity. Never create new release
  keys. The real ones (`release-private.pem`, `release-identity.p12` and its
  password) are backed up in the Obsidian vault at
  `~/Documents/personal/dev/localbox/release-signing/`, with a working copy at
  `~/dev/agent-computer/.release-signing/`; for a release, copy that folder
  into the checkout as `.release-signing/`. If slice 05 ends up needing a
  separate Sparkle key (it needs the user's sign-off first), it is backed up
  in the same vault folder, and noted in "Release signing and key backup.md"
  there, before the first publish.
- Never `pkill` Virtualization processes (Colima is one). Manual daemon runs
  need a scratch `HOME` or `LOCALBOX_MACHINE_ROOT`.
- Logging out or sleeping the development Mac kills your session. Those legs
  are manual and listed under [Open verification](#open-verification).
- Do not modify `~/dev/bento`. Read it at commit
  `45a61d39f49e3bb431daecd9023fa4eb59950692` with `git -C ~/dev/bento show`.

**TODO**

- [ ] 01 [Spike: hands-off first launch and login item](slices/01-first-launch-spike.md)
- [ ] 02 [Spike: VMs under an app-supervised child](slices/02-vm-child-spike.md)
- [ ] 03 [Spike: the whole runtime signed in one bundle](slices/03-signed-bundle-spike.md)
- [ ] 04 [Spike: built-in image fetch](slices/04-image-fetch-spike.md)
- [ ] 05 [Spike: patched Sparkle, N to N+1](slices/05-sparkle-spike.md)
- [ ] 06 [Daemon: supervised mode, one daemon per root](slices/06-daemon-supervised.md)
- [ ] 07 [CLI: app-managed layout, launcher, home command](slices/07-cli-app-managed.md)
- [ ] 08 [App shell: lifetime and supervision](slices/08-app-shell.md)
- [ ] 09 [App control: socket, login item, `localbox app`](slices/09-app-control.md)
- [ ] 10 [Release, agent install, and deleting the old path](slices/10-release-cutover.md)
- [ ] 11 [Built-in image on first launch](slices/11-builtin-image.md)
- [ ] 12 [App facts: the one state shape](slices/12-app-facts.md)
- [ ] 13 [Popover](slices/13-popover.md)
- [ ] 14 [Settings window](slices/14-settings.md)
- [ ] 15 [Updates](slices/15-updates.md)
- [ ] 16 [Closeout](slices/16-closeout.md)

**Before you end a pass,** update this section: the status line and date, the
next pickup point, any new warning, and the checklist. Record every decision
you made that a slice did not make for you in `choices.md` in this folder.

## Slice graph

```
01 first launch ───────────────────────────────┐
02 VM under app child ─┬─> 06 daemon ──┐       │
03 signed bundle ──────┼─> 07 CLI ─────┴─> 08 app shell ─> 09 app control ─> 10 release cutover ─┬─> 11 built-in image (needs 04)
04 image fetch         │                                         │                               │
                       └─> 05 Sparkle lab                        └─> 12 app facts ─┬─> 13 popover │
                                 │                                                 └─> 14 settings┤
                                 └───────────────────────────────────────────────────> 15 updates ┴─> 16 closeout
```

Slices 01–05 are throwaway spikes under `specs/menu-bar-app/spikes/`; none of
their code ships. Between slices 10 and 15 an installed app cannot update
itself. That is accepted: there are no users.

## Review map

| What you can look at | Slice |
| --- | --- |
| `spikes.md` verdicts and the hibernate timing table | 01–05 |
| Two daemons on one root: the second refuses | 06 |
| `localbox help` through a launcher in a scratch `HOME` | 07 |
| Dev app in the menu bar; quit hibernates, relaunch wakes | 08 |
| `localbox app status --json` | 09, 12 |
| Install from `ssh localhost` following the new `installation.md` | 10 |
| Popover shots, light and dark, every state | 13 |
| Settings shots beside Bento's | 14 |
| N to N+1 update with a sandbox running | 15 |

## Agent decisions made while planning

The user's decisions are in the brief. These are the calls made while merging
the three drafts; each names the alternative that lost.

| # | Decision | Lost alternative |
| --- | --- | --- |
| A1 | Bundle ids `sh.localbox.mac`, `sh.localbox.mac.dev`; CLI signing identifier `sh.localbox.cli`. | `sh.localbox.app`. |
| A2 | The app is a separate SwiftPM package, `apps/macos/App`, so Sparkle's framework flags never touch the daemon's `swift test`. | A target inside `HostDaemon`. |
| A3 | The connector waits for credentials when signed out and loops after a revoke, so `login` needs no "restart the connector" call. | Supervisor treats exit 0 as "stay down" plus a `connector.restart` socket operation. |
| A4 | The daemon keeps its start-time `agents reconcile`; the app adds no second trigger. | The app runs reconcile at launch. |
| A5 | The popover reads one CLI command, `localbox app status --json`, long-polled with `--since`. | A streaming `app watch` child; the app speaking the daemon socket itself. |
| A6 | The CLI fetches the built-in image (`localbox app image ensure`), reusing `expandImage` and `installLinuxImage`. | A daemon host operation in Swift. |
| A7 | The image's manifest is fetched at run time and verified against the public key sealed in the bundle. | Sealing the image descriptor in the bundle. |
| A8 | Sparkle's patch is re-applied under Localbox names (`localbox.patch`, same pinned commit). | Vendoring Bento's patch byte-identical, Bento names included. |
| A9 | Sparkle's appcast is signed with the existing Ed25519 release key, so there is one trust root and one secret. Slice 05 proves Sparkle accepts it. | A separate Sparkle seed (needs the user's sign-off, since it is new key material). |
| A10 | No move-to-Applications prompt. A copy outside an Applications folder runs, warns in the popover, and skips the home command and login item. | Bento's relocator prompt. |
| A11 | No uninstall command. `installation.md` documents the three steps. | `localbox app uninstall`. |
| A12 | Automatic updates wait while sandboxes are running and hibernation is unavailable; a manual install proceeds and says sandboxes will restart. | Always install. |
| A13 | A new proof tier `a`: the assembled app in a scratch root, launched `open -g`, never focused. | Folding packaged checks into tier `l`. |
| A14 | The minimum stays macOS 14. Bento's Settings code targets macOS 26; anything newer than 14 is guarded. | Raising the minimum. |

## Contracts

**Bundle layout** (one definition, in the assembler from slice 10; slice 03
proves it first):

```
Localbox.app/Contents/
  MacOS/Localbox                 the app
  MacOS/localbox-hostd           the daemon, signed with the virtualization entitlement
  Frameworks/Sparkle.framework   release builds only
  Resources/bin/localbox         the C launcher (the bytes of ~/.local/bin/localbox)
  Resources/cli/                 localbox (entry), dist/, node_modules/, skill/, skills-installer/, version
  Resources/node/bin/node
  Resources/guest-agent/         sealed bytes; digests match agent-version.json
  Resources/release-public.pem   equals skills/localbox/release-public.pem
```

**Names.** Launch lock `~/Library/Caches/sh.localbox.mac/launch.lock`; app
socket `<root>/app.sock`; daemon lock `<root>/hostd.lock`; Info.plist key
`LocalboxLaunchLockRelativePath`; relaunch argument
`--localbox-update-relaunch`; feed `https://localbox.sh/mac/appcast.xml`.

**Processes.** The app starts `localbox-hostd --supervised` and
`localbox connector run` as children with a stdin pipe each. Closing a child's
stdin is the stop signal. A release build is a bundle with `SUFeedURL`.

**CLI surface added:** `localbox app paths|status|login-item|image ensure`,
and `localbox update check|install|status` re-pointed at the app. Catalog
operations and their ids do not change; only `cli.status` state values do.

## Single-owner invariants

The end state must read as designed today. Each concept has one owner, and no
slice may add a second.

1. **Supervision.** `ChildProcess` in `LocalboxAppCore` is the only supervisor
   of the daemon and the connector. A release install has no launchd job.
   Probes may still start `localbox-hostd` directly on scratch roots.
2. **One daemon per root** is enforced by the daemon's own kernel lock, never
   by the supervisor's bookkeeping.
3. **Hibernation** happens in the daemon's one shutdown path (SIGTERM, stdin
   EOF, power-off). The app and the updater only wait for the daemon to exit.
   Nothing sends SIGKILL to a daemon that is saving.
4. **State root.** `packages/config` `machinePaths()` is the only definition.
   Swift learns paths from `localbox app paths --json` and never hardcodes
   `Application Support/Localbox`. The daemon's environment is built in one
   place, `DaemonLaunch`.
5. **The app does nothing the CLI can't.** Every read is
   `localbox app status --json`; every action is one CLI invocation through
   `BundledCLI`. The native-only powers (supervision, `SMAppService`, Sparkle,
   drawing) are reachable from the CLI through the app socket.
6. **Agent setup.** The CLI's `AgentSetup` is the only writer of the skill,
   `~/.local/bin/localbox` and the PATH block. The home command is a copy of
   the launcher's bytes, never a link into the bundle.
7. **App-managed** is decided by the CLI from its own realpath, never from an
   environment variable.
8. **The bundle** is written by the install procedure once and by Sparkle
   after that. The CLI never downloads a release. The launch lock's path has
   one source, shared by the Info.plist key and the launcher.
9. **`images/linux`** is written only by `app image ensure`, after the signed
   manifest and every digest verify against the one pinned public key.
10. **Warnings** are computed once, in the facts the CLI returns. Views render
    them.

## Firewalls

These must not change: the operation catalog and `packages/contract` beyond
`cli.status` states; the LocalIPC wire format; `SandboxHost` power, idle and
shutdown logic; `AgentSetupCLI.swift`; `SkillManager` receipts; `ImageTransfer`;
the guest agent and its digests; the `agent-computer.release.v1` manifest
schema; `skills/localbox/release-public.pem`; the contents of
`.release-signing/`; the machine root's layout and the credential path;
`apps/guest-agent/darwin` (the guest's own launchd units); probes that start
the daemon with no app; `~/dev/bento`.

## Standing verification gates

- `npm test`, `npm run build` and `swift test --package-path
  apps/macos/HostDaemon` stay green after every slice; from slice 08 on, so do
  the app package's tests.
- **Every visual shot** (slices 13, 14, 15) gets an unprimed
  [screenshot-critique](../../.agents/skills/screenshot-critique/SKILL.md) as
  its last check before the slice is accepted.
- **Every shot with a reference** gets
  [compare-screenshots](../../.agents/skills/compare-screenshots/SKILL.md)
  against that reference, judging the one variable its slice names.
- Reference shots, candidates and critiques are kept under `assets/` and
  `evidence/` in this folder, not only in mutable snapshot folders.
- Human checkpoints never block. Open the shots, give the user about five
  minutes, then decide on the evidence, record why, close the shots and go on.

## Known unknowns

Each is owned by a spike; see the brief's "Known fog" for the full statement.

| Unknown | Owner |
| --- | --- |
| `open -g` and `SMAppService.mainApp.register()` from SSH with no click | 01 |
| Any privacy prompt (Local Network, App Management) that needs a click | 01, 05 |
| Virtualization and hibernate under an app child; hibernate wall time | 02 |
| Inside-out signing with guest binaries sealed; Node JIT in the bundle | 03 |
| Range resume through GitHub's redirect; peak disk | 04 |
| Patched Sparkle under Localbox names; the 20 s termination timeout | 05 |
| Logout, shutdown and a headless Mac | [Open verification](#open-verification) |

## Open verification

Manual legs no agent session can run. Slice 16 turns them into a runbook.

- Real logout and real shutdown with two sandboxes running: did they hibernate,
  and how long did macOS wait?
- A headless Mac (automatic login, no display): after a reboot, does
  `localbox app status` over SSH show the daemon running and the Mac connected?
- A real-account install from a published release on a Mac that never had
  Localbox.
