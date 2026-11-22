# Menu bar app

Localbox ships as a Mac menu bar app, `Localbox.app`, with the `localbox` CLI
inside it. An agent installs it with no click and no password by following the
[installation procedure](../../../skills/localbox/references/installation.md).
The app supervises the VM daemon and the connector as its children, shows this
Mac's sandboxes, images and warnings in a popover, has a Settings window copied
from Bento's, opens at login, and updates itself with a patched Sparkle. It
replaced the old install outright: the versioned release folders, the three
launchd jobs, the installer script, the updater job and rollback are gone.

- The decisions this rests on: the [brief](brief.md) (the user's decisions
  1–12, the Bento reference digest) and the [plan decisions](#plan-decisions)
  below (A1–A14).
- Every further choice the build made, and its verdict: the
  [choices ledger](choices.md). Its **Needs your call** entries (N1, N2,
  N4–N7; N3 was fixed and is now S42) are live trade-offs the user owns, its
  **Unsound** group is empty (the closing
  audit's U1 and U2 were redone and are now S40 and S41), and its
  **Provisional** entries (V1–V6) each wait on something named.
- What the spikes found: [spikes.md](spikes.md), with each full write-up in
  `spikes/NN/verdict.md`.
- There is no backward compatibility: Localbox was unlaunched, so the old
  install was deleted and nothing migrates.
- Out of scope: creating or deleting sandboxes or images from the UI, a Dock
  icon or main window, a viewer for a sandbox's desktop, Developer ID and
  notarization, Intel Macs.

Everything is built and proven at the tiers the work named, including a
release-shaped install, sign-in, sandbox and N to N+1 update on the
development Mac's own account. What no agent session can run is the
[manual runbook](#open-verification).

## Why it works this way

**The app owns everything, and quitting it takes the Mac offline.** The app
starts `localbox-hostd --supervised` and `localbox connector run` as children
with a stdin pipe each; closing the pipe is the stop signal, and the kernel
closes it when the app dies, so even a killed app stops its children (brief
1). There is no launchd job. Bento found that macOS refuses a LaunchAgent whose
binary changes on update under a self-signed identity ("Launch Constraint
Violation"), so a background service would break at the first update. The
price is that a Mac where the app isn't running serves nothing, which is why
Open at login is on by default (brief 5) and why any `localbox` command opens a
quit app quietly (brief 6).

**Hibernation is the daemon's, and nothing kills a daemon that is saving.**
Every way down (Quit, SIGTERM, logout, an update, stdin closing) runs the
daemon's one shutdown path, which saves each running sandbox's memory to disk
and wakes it at the next start with its processes intact. Spike 02 measured
four 2 GiB sandboxes at 3.2–10.7 s, so Bento's fixed 4 s + 2 s stop window
would have cut saves short; the app waits for the daemon however long it takes
(choice N1 is what that costs).

**The app is a supervisor and a view over the CLI.** Every popover and
Settings read is `localbox app status --json`, and every action is one bundled
CLI invocation (brief 12). The few powers only a native app has (supervision,
the login item, Sparkle) are reachable from the CLI through one Unix socket,
`<root>/app.sock`. So an agent can do anything a person can from the menu, and
the warnings a person sees are the ones the CLI computed.

**The CLI decides the paths, from the bundle it runs in.** `machinePaths()` is
the only definition of the machine root; the CLI learns which app it is in
from its own realpath and that bundle's id, never from an environment
variable. Only the release id owns the real root and credential; a development
or rehearsal build gets its own, so no test build can ever become this Mac's
real install (choice S9).

**The home command is a copy of a small launcher, held by a lock.**
`~/.local/bin/localbox` is the bytes of a C launcher, not a link into the
bundle. It takes a shared lock for the CLI's whole life; Sparkle's patched
installer takes it exclusively while it replaces the bundle, so no command
ever runs half a replaced CLI, and the update waits for running commands.

**Install is a procedure, not an installer.** The agent downloads three files,
verifies `release.json`'s Ed25519 signature against a key pinned in the
procedure itself, checks the zip's digest, puts the app in `~/Applications`
(no administrator needed, brief 8), and opens it with
`launchctl asuser … open -g`, which works from a non-GUI session without
taking focus. A stock Mac has no tool that verifies Ed25519, so the procedure
carries the verifier and runs it in the system's JavaScriptCore shell (choice
V3). The app then installs the skill and the command itself.

**The 2 GB Linux image is fetched, not bundled.** At every launch the CLI's
`app image ensure` downloads this version's image with resume, checks it
against the same signed manifest, and swaps it in by one rename (brief 2,
A6, A7). The daemon tells a create to wait, retryably, while it arrives.

**Updates install only after the slow part is over.** Sparkle owns the feed,
the schedule, the verified download and the replacement. Its helper gives the
app 20 s to exit after the permit, which no hibernation budget fits, so
`UpdateCoordinator` reverses Bento's order: it stops the children (the daemon
hibernating as long as it needs) and waits for running commands while Sparkle
waits, and only then grants the permit. The feed and archive are signed with
the existing release key, so there is one trust root (A9).

## The user's decisions, as shipped

| # | Decision | As shipped |
| --- | --- | --- |
| 1 | The app owns everything | `ChildProcess` supervises the daemon, the connector and the image one-shot; no launchd job remains. |
| 2 | Sparkle, Bento's patch, appcast via `localbox.sh`, image fetched separately | Patch re-applied under Localbox names (A8), plus `HOME` in the relaunch (N4 ⚠). `https://localbox.sh/mac/appcast.xml` 302s to the latest release's `appcast.xml` (`apps/site/vercel.json`). |
| 3 | Bento-style popover | `NSStatusItem` + `NSPopover`: header, warning band, sandboxes with Copy Name, Sleep/Wake, Open Log, images in progress (by the account's name, S42), Settings…, Quit. |
| 4 | Settings copies Bento's window | About and General are Bento's, row for row; Workspace became Account. |
| 5 | Open at login on by default | Registered once by a release in an Applications folder; the person's choice stands after (S12). |
| 6 | A command with the app quit launches it quietly | `ensureApp`: `open -g`, one retry, up to 20 s (S14). |
| 7 | Self-signed "Localbox Release", not notarized | Inside-out signing, no hardened runtime, no timestamp (S32). |
| 8 | Seamless install; `~/Applications` | As stated (N6). |
| 9 | No rollback | Forward only (N7). |
| 10 | No backward compatibility | The old installer, updater, plists and command link were deleted. |
| 11 | Every id under `sh.localbox.*` | Bundle ids, CLI identifier, launch lock, sockets; `tests/naming.test.ts` enforces it. |
| 12 | The app does nothing the CLI can't | One socket, one read; every action, sign-in included, reads the CLI's `--json` envelope (S40). |

## Plan decisions

Calls made while planning, still in force. The ledger records where the code
made a further choice inside one.

| # | Decision | Lost alternative |
| --- | --- | --- |
| A1 | Bundle ids `sh.localbox.mac`, `sh.localbox.mac.dev`; CLI signing identifier `sh.localbox.cli`. | `sh.localbox.app`. |
| A2 | The app is its own SwiftPM package, `apps/macos/App`, so Sparkle's flags never touch the daemon's `swift test`. | A target inside `HostDaemon`. |
| A3 | The connector waits for credentials when signed out and after a revoke, so `login` needs no restart call. | Exit 0 meaning "stay down", plus a restart operation. |
| A4 | The daemon keeps its start-time `agents reconcile`; the app adds no second trigger. | The app runs reconcile at launch. |
| A5 | The popover reads one command, `localbox app status --json`, long-polled with `--since`. | A streaming child; the app speaking the daemon's socket. |
| A6 | The CLI fetches the built-in image (`localbox app image ensure`). | A daemon operation in Swift. |
| A7 | The image's manifest is fetched at run time and verified against the key sealed in the bundle. | Sealing the image descriptor in the bundle. |
| A8 | Sparkle's patch is re-applied under Localbox names (`localbox.patch`, pinned commit). | Vendoring Bento's patch byte for byte. |
| A9 | Sparkle's feed is signed with the existing Ed25519 release key. | A separate Sparkle key (new key material). |
| A10 | No move-to-Applications prompt; a copy elsewhere runs and warns. | Bento's relocator. |
| A11 | No uninstall command; `installation.md` documents removal. | `localbox app uninstall`. |
| A12 | Automatic updates wait while sandboxes run and hibernation would fail right now (the screen locked, its lock asking for a password; S41); a manual install proceeds. | Always install. |
| A13 | Proof tier `a`: the assembled app in a scratch root, launched `open -g`, never focused. | Folding packaged checks into tier `l`. |
| A14 | The minimum stays macOS 14; Settings uses only macOS 13–14 APIs. | Raising the minimum. |

## Principles and invariants

The single-owner rules live with the code, in the
[app's README](../../../apps/macos/App/README.md#principles), and this record
doesn't repeat them: the app as supervisor and view, `ChildProcess` as the one
supervisor, the daemon's one shutdown path and the never-SIGKILL rule, paths
from `machinePaths()` through `app paths`, `AgentSetup` as the only writer of
the skill, command and PATH block, the bundle's two writers, `app image
ensure` as the only writer of `images/linux`, warnings computed once,
`LoginItem` and `UpdateCoordinator` as the only owners of their concerns.
[SECURITY.md](../../../SECURITY.md#what-runs-on-the-mac) says what runs on the
Mac, and the [skill lifecycle](../../../skills/localbox/references/skill-lifecycle.md#updates)
how it updates.

Invariants outside the app package that would break silently if violated:

- **Only `sh.localbox.mac` owns the real root.** `stateName` in
  `packages/config/src/machine-paths.ts` gives every other bundle id its own
  root, logs and credential.
- **The daemon refuses to start without `LOCALBOX_HOSTD_LOCK`,** and takes the
  lock before it touches the root; `--supervised` is its only argument.
- **The launch lock's path has one source,** the `#define` in
  `apps/macos/App/launcher/main.c`; `build-app.mjs` copies it into Info.plist,
  and Sparkle's helper reads it from there.
- **The installation procedure is executable documentation.**
  `scripts/proof/lib/installation.ts` cuts each `sh` block out of
  `installation.md`; `tests/release.test.ts` and probe 42 run them as written,
  so editing the document changes what the tests run.
- **The firewalls held:** the operation catalog and `packages/contract`
  (beyond `cli.status` states), the LocalIPC wire format, `SandboxHost`'s power
  and idle logic, the guest agent and its digests, the release manifest schema
  and the pinned public key are unchanged.

## Where to look

- The app: `apps/macos/App/Sources/LocalboxAppCore` (`ChildProcess`,
  `Lifetime`, `DaemonLaunch`, `AppSocket`, `AppControl`, `LoginItem`,
  `LaunchDecision`, `LaunchLock`, `FactsSource`, `AppFacts`,
  `PopoverPresentation`, `SettingsModel`, `UpdateCoordinator`, `BundledCLI`),
  `Sources/LocalboxMenu` (the SwiftUI views), `Sources/Localbox`
  (`main.swift`, `MenuBar`, `SettingsWindow`, `SparkleDriver`). Tests:
  `apps/macos/App/tests/*.test.mjs` (`npm run test:app`); view shots
  `npm run app:shots`.
- The bundle and its signature: `apps/macos/App/scripts/build-app.mjs`,
  `sign.mjs`, `cli-entry.sh`, `launcher/main.c`; Sparkle in
  `apps/macos/App/sparkle/` (`npm run sparkle:build`).
- The CLI: `apps/cli/src/app.ts` (`app paths`, `app login-item`),
  `app-socket.ts`, `app-launch.ts`, `app-facts.ts`, `builtin-image.ts`,
  `update.ts`, `agent-setup.ts`, `shell-profile.ts`; `packages/config`
  (`machine-paths.ts`, `app-bundle.ts`). Tests: `tests/app-*.test.ts`,
  `builtin-image.test.ts`, `update-command.test.ts`, `agent-setup.test.ts`,
  `shell-profile.test.ts`, `launcher.test.ts`, `connector-supervised.test.ts`,
  `naming.test.ts`.
- The daemon's side: `HostDaemonCore/DaemonShutdown.swift`,
  `MachineLock.swift`, `BuiltinImageWait.swift`, `host.watch` in
  `SandboxHost.swift`; `DaemonLifetimeTests`, `BuiltinImageWaitTests`.
- Release: `scripts/release.sh`, `scripts/release.ts`, `scripts/appcast.ts`;
  `tests/release.test.ts`, `tests/appcast.test.ts`;
  [DEVELOPMENT.md](../../../DEVELOPMENT.md#releases-are-the-only-install-path).
- Probes: `40-supervised-daemon`, `41-app-lifetime`, `42-release-bundle`,
  `43-builtin-image`, `44-installed-update`, plus `14-agent-setup` and
  `13-scenario` as reworked (`npm run proof -- NN --tier …`).

The ledger's **When** fields and the spike write-ups use the build's slice
numbers. There were no slices 03 and 05 (the dropped spikes, below).

| # | Built | # | Built |
| --- | --- | --- | --- |
| 01 | first launch and login item (spike) | 10 | release, agent install, old path deleted |
| 02 | VMs under an app child (spike) | 11 | built-in image on first launch |
| 04 | built-in image fetch (spike) | 12 | app facts |
| 06 | daemon supervised mode | 13 | popover |
| 07 | CLI app-managed layout, launcher, home command | 14 | Settings |
| 08 | app shell: lifetime and supervision | 15 | updates |
| 09 | app control: socket, login item | 16 | closeout, real-account proof |

## Dead ends and divergences

What the build found that the plan didn't predict.

**Dropped spikes.** Spike 03 (signing a bundle with a CLI and Node inside) and
spike 05 (the patched Sparkle update) were never run. Bento and Yap already ship
both on self-signed apps with working updates, so the build ported their code
and checked only what was new to Localbox: the daemon keeping its
virtualization entitlement inside the bundle, the guest agent's bytes surviving
the bundle's signature, Node's JIT without the hardened runtime (slice 10);
hibernating before Sparkle's permit, a sandbox saved by N waking under N+1, and
Sparkle accepting a feed signed by the release key (slice 15). All held.

**What the spikes found** (details in [spikes.md](spikes.md)):

- `open -g` and `SMAppService.mainApp.register()` work for a self-signed app
  in `~/Applications` with no click, also with the screen locked; macOS shows
  only a banner. A quarantined bundle is held by a Gatekeeper dialog and every
  later launch from that path hangs, so the procedure stops on quarantine.
- The SSH leg could only be approximated (no key login to localhost); the
  stand-in ran in the GUI session's bootstrap, not an SSH session's (V2).
- The daemon boots, hibernates and restores real VMs as an app's child, signed
  self-signed inside a bundle. An app killed with `kill -9` left an orphan
  daemon running its VMs, which is why the daemon now stops on stdin EOF. One
  restore in about 40 cold-booted, cause unknown (V1). `open` failed once in
  about 70 launches right after an exit, which is why the quiet launch retries.
- The keychain's "Agent Computer Local" identity blocks `codesign` on a dialog
  nobody can click, so probes sign with a throwaway identity in a disposable
  keychain.
- `Range` resume works through GitHub's release redirect. The daemon's
  start-up sweep would delete a download staged inside `images/`, so staging
  moved to `<root>/downloads/`.

**Divergences from the plan:**

- The CLI's old-install link and the tarball layout were kept while slices
  07–09 ran, then deleted in slice 10. Between slices 10 and 15 an installed
  app could not update itself; that was accepted, with no users.
- A bundle is a release when it carries `SUFeedURL`, not by its bundle id
  (S11).
- The built-in image is installed by `replaceLinuxImage` (one rename);
  `installLinuxImage` moved to the proof library, because a shipped copy was
  a second writer of `images/linux`.
- `Lifetime.ensureImage()` was planned as the hook for an update's new image;
  it went, because every Sparkle install ends in a relaunch, and every launch
  runs `ensure`.
- `localbox login` turned out to print text even with `--json`, and the build
  shipped Settings reading it by exit code. After the closing audit the CLI
  was changed to answer with its envelope (S40), and automatic updates were
  changed to wait on the screen being locked now rather than on the lock
  setting alone (S41).
- The popover's image rows showed image ids, since the daemon knew no names.
  After the closing audit the connector's image mirror was changed to carry
  each image's name, which the daemon hands to the facts (S42).
- Probe numbers moved: the release is 42, the image 43, the update 44.
- The daemon's fallback lock path, kept for the deleted launchd plist, went in
  the whole-spec review; the variable is now required.

**What the real-account proof found** (`evidence/16/real-account-proof.md`).
A release-shaped bundle under its own id was installed on the development
Mac's account with the procedure's own blocks, signed in to a local stack, ran
a sandbox, updated N to N+1 through Sparkle with the sandbox's counter
continuing, and was removed, leaving the account as it found it.

- Before it, any unknown bundle id fell back to the real root; that is why
  only `sh.localbox.mac` owns it now.
- A pre-launch check of the paths the installed CLI would use refused the first
  bundle, assembled from a stale `dist/`, before it ran.
- `update check` answered the previous cycle's "You're up to date." while the
  update was installing; it now answers `checking` at once.
- The procedure's step 6 status checks read `missing` in the stripped shell,
  because the rehearsal's scratch command and skill paths came from the
  bundle's `LSEnvironment`; with the same environment they read `installed`.
  A rehearsal artifact, not a procedure fault.
- Whether System Settings keeps a disabled login-item record after removal
  could not be checked without an administrator (V4).

**A test hang, fixed in the test.** `DaemonLifetimeTests` hung twice: the
daemon had exited, but `Process.waitUntilExit()` on a concurrency thread never
returned while a stderr `readabilityHandler` spun at EOF. The handler now stops
at EOF and the async tests poll `isRunning`.

## Open verification

The [manual runbook](manual-runbook.md) holds the legs no agent session can
run, with results to be recorded under `evidence/manual/`:

1. Real logout and real shutdown with two sandboxes running: did they
   hibernate and wake, and how long did macOS wait?
2. A headless Mac after a reboot: does the login item bring Localbox up with
   no display and no click?
3. A first install from a published release on a Mac that never had Localbox,
   including the built-in image's real download time and peak disk.
4. A true SSH install from another machine (V2).
5. Evidence capture for the rare cold boot, whenever it happens (V1).

## Visual provenance

The standard was Bento's own app at commit
`45a61d39f49e3bb431daecd9023fa4eb59950692` (`~/dev/bento`, read-only). Its
references were rendered, not read off the code: a `git archive` of Bento at
that commit, built in scratch, with its own shot runners drawing its real
views on this Mac (macOS 27).

| Image | What it is | What it drove |
| --- | --- | --- |
| `assets/bento-popover.png` | Bento's idle popover, 1x, dark backing, from its `capture-view` runner. | The popover's chrome: 352 pt width, 16 pt padding, the 30 pt mark and title, 48 pt rows, the warning banner, the footer. |
| `assets/bento-settings-{light,dark}-manual.png`, `…-manual-bottom.png` | Bento's Settings in its manual-updates state, 560 × 780 at 1x, top (About) and scrolled to the end (General), from its `settings-view-shots.mjs`. | Settings row for row (brief 4). |
| `evidence/13/` | Every popover state, light and dark, at 2x, from `npm run app:shots`; `compare/` holds the header-band comparison with Bento's. | Landmarks within 1 px of Bento's; one deliberate deviation (the section label uses the system secondary colour). An unprimed critique's fixes landed before acceptance. |
| `evidence/14/` | Every Settings state, light and dark, 1x; `compare/` the About and General side by side with Bento's; `critique.md`. | About pixel-identical to Bento's; General identical apart from the name. |
| `evidence/15/` | Settings' update rows in each state; `critique.md`. | Every row at Bento's offset from the section's bottom. |
| `evidence/16/contact-sheet.png` | The final popover, Settings and update states on one sheet. | The closing look at the whole surface. |

`npm run app:shots` writes `evidence/13`–`15` again from the production views
with synthetic facts. `evidence/01`, `02` and `04` are the spikes' logs and
probe output; `evidence/16/real-account-proof.md` is the real-account run.

Kept at close: this README, `brief.md`, `choices.md`, `spikes.md` and the three
`spikes/NN/verdict.md` write-ups, `manual-runbook.md`, `assets/` and
`evidence/`. Removed at close: `slices/` (the build plan; what it found is
folded in here and in the ledger) and the spikes' throwaway source, which
never shipped and is in git at `d0f7bb3` under `specs/menu-bar-app/spikes/`.
