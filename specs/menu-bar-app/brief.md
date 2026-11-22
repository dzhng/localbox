# Menu bar app: planning brief

The interview record for this spec. Every drafter gets this file and nothing
else. Decisions marked **User** are the user's; **Agent** are calls the user
delegated.

## Goal

Localbox ships as a Mac menu bar app, `Localbox.app`, with the `localbox` CLI
inside it. An agent still installs it, with no user action. The app replaces
today's install (versioned release folders under
`~/Library/Application Support/Localbox/releases`, three launchd jobs
`sh.localbox.hostd` / `.connector` / `.updater`, `install-release.sh`,
`rollback-release.sh`).

## Decisions

1. **User: the app owns everything.** The app supervises the VM daemon
   (`localbox-hostd`) and the connector as child processes, the way Bento's app
   supervises its sync daemon. Quitting the app hibernates/sleeps sandboxes and
   takes this Mac offline. No launchd jobs remain.
2. **User: Sparkle for updates**, reusing Bento's patched Sparkle build (the
   patch makes the installer hold the CLI launch lock through replacement). The
   appcast is a release asset on the public GitHub repo (`dzhng/localbox`),
   reached through a permanent `localbox.sh` URL that redirects to the latest
   release. The ~2 GB built-in Linux image stays out of the app bundle; the app
   fetches it separately, checked against the signed release manifest.
3. **User: Bento-style popover** from an `NSStatusItem` (not a plain `NSMenu`),
   showing all of:
   - a status header: signed-in account, whether this Mac is connected, room
     left (CPUs, memory, disk), version, and a warning when something needs
     fixing (signed out, connector down, hibernation blocked by a screen
     password);
   - this Mac's sandboxes with state (running, asleep, copying with progress);
     per sandbox: copy name, sleep, wake, open log. Delete stays in the CLI;
   - images building or copying on this Mac, with progress;
   - Settings… and Quit.
4. **User: Settings copies Bento's window exactly** where a section applies:
   the same 560-pt grouped SwiftUI `Form` in an `NSWindow`, the same About and
   General sections with the same wording and layout ("Show this window when
   Localbox starts", "Set up my agents", "Open at login" with the Login Items
   fallback button, "Automatically download and install updates", "Check for
   Updates", the same footers). Bento's Workspace section becomes Account
   (Localbox's email-code sign-in). Bento's Sync, Recording, Shortcuts, Outbox
   and Permissions sections have nothing to control and are left out.
5. **User: Open at login is on by default** (`SMAppService.mainApp`), since a
   Mac without the app running is offline. The agent tells the user; Settings
   can turn it off.
6. **User: a CLI command with the app not running launches the app quietly**
   (`open -g`), waits up to about 20 s for the daemon, then runs.
7. **User: keep the self-signed "Localbox Release" identity**, not notarized,
   as today and as Bento. Release keys live in `.release-signing/`; never
   regenerate them.
8. **User: install must be seamless.** "A user can just ask their agent
   remotely to install and agent will have everything to do it, no other user
   action required." No password prompt, no click. **Agent:** so the app
   installs to `~/Applications/Localbox.app` (never needs admin), using
   `/Applications` only when a copy is already there and writable.
9. **User: drop rollback.** Sparkle installs forward only.
10. **User: no backward compatibility, no migrations.** The product has no
    users. Hard cutover; delete the old install path outright.
11. **User: every reverse-DNS id is `sh.localbox.*`** (done in commit a45a38f
    for the launchd labels and IPC queues). The app's bundle id, dev bundle id,
    CLI signing identifier, Sparkle lock path and sockets follow the same root.
12. **Inherited from Bento (Agent, D7/A3 there):** the app does nothing the CLI
    can't. Every popover and Settings action runs the bundled CLI with `--json`;
    the CLI owns account state, skill install and the `localbox` command.

## What exists today (measured in this repo)

- `scripts/release.sh` builds `Localbox.app` (only `localbox-hostd`, its
  entitlements, the launchd plists and `Resources/guest-agent/`) plus a
  separate `localbox-cli-VERSION.tar.gz` (compiled JS under `dist/`, a bundled
  Node binary, `bin/localbox` = `scripts/cli-launcher.sh`, the skill, the
  pinned `skills` installer) plus the Linux image as zstd parts, and a signed
  `release.json` (Ed25519, public key pinned in the skill) with `SHA256SUMS`.
- `scripts/install-release.sh` (239 lines) verifies the manifest, unpacks into
  `releases/VERSION`, activates it (`active` symlink), expands the Linux image
  into `images/linux`, writes the three launchd plists with paths and
  environment (`LOCALBOX_SOCKET`, `LOCALBOX_IPC_TOKEN_PATH`,
  `LOCALBOX_SANDBOXES`, `LOCALBOX_OPERATIONS`, `LOCALBOX_IMAGES`,
  `LOCALBOX_GUEST_AGENT`, `LOCALBOX_CLI`, `LOCALBOX_BIN_DIR`), creates the IPC
  token, adds `~/.local/bin` to PATH (`scripts/localbox-path.sh`), runs
  `localbox agents reconcile` (skill + command link) and bootstraps the jobs.
- `apps/cli/src/updater.ts` + the `sh.localbox.updater` job poll GitHub
  releases and run the installer; `scripts/rollback-release.sh` swaps back.
- `apps/cli/src/connector-job.ts` restarts the connector launchd job after
  login. `localbox connector run` is the connector process (Node, in the CLI).
- The daemon hibernates running sandboxes on stop and resumes them on start
  (`SandboxHost` power events; saved VM state needs an unlocked session).
  `localbox host check` reports hibernation availability.
- The daemon runs `localbox agents reconcile --reason daemon_start` at every
  start (`AgentSetupCLI.swift`), which keeps the skill and command current.
- Swift package `apps/macos/HostDaemon` (targets `HostDaemonCore`,
  `localbox-hostd`, `ImageTransfer`, `ImageCopyTransfer`, lab executables).
  The daemon needs the `com.apple.security.virtualization` entitlement.
- State the menu needs is already served: `host.watch` (long poll: capacity,
  sandbox states), `sandbox list`, `image list`, `image wait` (progress),
  `relay status`, `host check`, `skill status`, `cli status`,
  `agents setup status|set`, `login`/`logout`, `update check`.
- Proof harness: `npm run proof -- NN --tier u,s,l,v,m,x`; unit tests
  `npm test` (297) and `swift test` (105). Docs: `DEVELOPMENT.md`,
  `apps/macos/HostDaemon/README.md`, `skills/localbox/` (installation.md,
  skill-lifecycle.md), `SECURITY.md`, README, site `apps/site`, `llms.txt`.
- The site and skill tell agents to install by following
  `https://localbox.sh/llms.txt`.

## Reference: Bento's menu bar app

Source: `~/dev/bento` at git ref `origin/main` (read with
`git -C ~/dev/bento show origin/main:<path>`; a snapshot of `apps/macos`,
`specs/done/mac-app` and `skills/bento` may still be at `/tmp/bento-ref`). Do
not modify that repo. Copy mechanisms, not capture/recording features.

- **Bundle:** `Contents/MacOS/Bento` (SwiftPM app), `Frameworks/Sparkle.framework`
  (patched), `Resources/cli/` (compiled CLI + sidecars), `Resources/bin/bento`
  (small C launcher), `Resources/node/bin/node`. `LSUIElement=true`,
  `setActivationPolicy(.accessory)`. Release id `ing.bento.mac`, dev id
  `ing.bento.mac.dev` (separate TCC grants, no update feed); the bundled CLI is
  always signed with a fixed identifier `ing.bento.cli`. "Is this a release" =
  "has `SUFeedURL`" (`LaunchDecision.swift`).
- **UI:** AppKit `NSStatusItem` + `NSPopover` (`RecordingControls.swift`,
  `CapturePopover.swift`, `CaptureView.swift`); Settings is an `NSWindow`
  hosting a SwiftUI `Form` (`SettingsWindow.swift`, `SettingsModel.swift`).
  Settings reads and writes only through `BundledCLI.swift` (spawns
  `cli/bento <args> --json`, stderr JSON errors to a temp file). Refresh on
  window open and after each mutation.
- **Reverse channel:** `AppSocket.swift`, a Unix socket under the state root;
  one JSON line in, one out; answers `update.*`, `login.*`, `cli.*`, `skill.*`.
- **Home command:** not a symlink. `CommandArtifact.swift` writes the bundled C
  launcher's bytes to `~/.local/bin/bento` (temp + rename, 0755), only when the
  app is in an Applications folder, re-applied on every launch while "Set up my
  agents" is on (`HomeLifecycle.swift`). `ShellProfile.swift` adds a marked
  PATH block only when no login file already covers `~/.local/bin`.
- **C launcher** (`scripts/launcher/main.c`): takes a shared `flock` on
  `~/Library/Caches/<bundle id>/launch.lock`; if held exclusively exits 75
  `UPDATING`; picks `$BENTO_APP`, then `~/Applications`, then `/Applications`;
  `execv`s `Contents/Resources/cli/bento`. The CLI knows it is app-managed from
  its own realpath, never from an env var.
- **Updates:** `scripts/sparkle/bento.patch` against a pinned Sparkle commit;
  the installer holds the launch lock exclusively through replacement and
  relaunch. `SparkleDriver.swift` is a custom `SPUUserDriver` with no Sparkle
  UI. `UpdateCoordinator.swift` gates install on native blockers, then on every
  CLI client releasing the shared lock. Feed hostname is permanent (D15) and
  302s to the latest GitHub release. Sparkle keys: an Ed25519 seed in
  `.release-signing/`; losing it strands installs.
- **Lifetime:** `ChildProcess.swift` supervisor: backoff 1 s doubling to 30 s,
  reset after 30 s up; shutdown closes stdin, waits 4 s, SIGTERM, 2 s, SIGKILL
  of the process group. The child refuses to start unless its parent is the
  app's pid, holds an `O_EXLOCK` kernel lock, and exits when stdin closes.
  `LaunchDecision.decide`: update relaunch proceeds; dev proceeds; another
  running release copy gets a hand-off; a release outside Applications offers
  a move (`AppRelocator.swift`). `SMAppService.mainApp` for Open at login.
- **Dead end to inherit (D34/D35):** a LaunchAgent / `SMAppService` agent whose
  binary changes on update was refused by macOS ("Launch Constraint Violation,
  needs LWCR update") under a self-signed identity. That is why children are
  app-supervised.
- **Agent install** (`skills/bento/references/setup.md`): curl `SHA256SUMS`,
  `release.json` and the zip from `releases/latest/download`, `shasum -c`,
  `ditto -x -k`, quit an existing copy with `osascript`, move it to a backup,
  `ditto` the new one in, `open` it. The app then installs the command and the
  skill itself. Verify with `cli.status` / `skill.status`.
- **Signing:** stable self-signed cert, inside-out, `--timestamp=none`, not
  notarized, built locally, published as a draft first.
- **Tests:** Node runners compile small Swift drivers against production
  sources in scratch `HOME`s (`home-lifecycle`, `shell-profile`,
  `launch-decision`, `child-process`); `--packaged` runs against the assembled
  app with a Finder-like env; offscreen view shots render real views with
  synthetic facts (`settings-view-shots.mjs`); `installed-update-lab` proves a
  signed N→N+1 update on a local feed with scratch keys.
- **Other lessons:** resolve the state root through the CLI, never hardcode it;
  give every shared resource a unique name; real-account install proof ran on
  the user's own account with the dev build and undid itself (D33).

## Known fog (unproven for Localbox)

- **Remote, hands-off first launch.** An agent over SSH (or a remote Claude
  session) must `open` a self-signed app that then registers
  `SMAppService.mainApp`, with no click. Does `open` work from a non-GUI
  session when a user is logged in at the console? Does `register()` return
  `.enabled` without approval for a self-signed app in `~/Applications`? Does
  macOS show only a notification?
- **Virtualization under an app-supervised child.** `localbox-hostd` today is a
  launchd job. As a child of a `LSUIElement` app: does the virtualization
  entitlement still apply (it is per-binary), does hibernate/restore still work
  (it needs the session key), do VMs survive nothing-but-app-quit correctly
  (they must hibernate before the child exits)?
- **Quit and update with running VMs.** Hibernating several VMs can take longer
  than Bento's 4 s + 2 s shutdown window; macOS logout/shutdown gives apps
  limited time. The Sparkle install must wait for hibernation.
- **Sparkle patch reuse.** Bento's patch embeds Bento names (lock path, keys).
  Reuse needs it parameterized or re-applied for `sh.localbox.*`.
- **Headless Macs.** A Mac mini with auto-login and no display: does a menu bar
  app start at login and run fine with no screen? (Today's jobs already need a
  GUI login session.)
- **CLI runtime in the bundle.** Today's CLI is compiled JS plus a Node binary
  kept outside the hardened runtime so V8 can JIT. Inside a signed app bundle,
  nested code must be signed inside-out; the guest agents are already sealed as
  resources.
- **Linux image delivery.** First launch needs a ~2 GB download before any
  sandbox can be created: progress in the popover, resumable, verified.
- **Proof harness.** Probes start daemons directly with scratch roots; they
  must keep working without the app, and new probes must drive the packaged
  app without stealing focus.

## Out of scope

- Anything in the popover that the CLI can't do; deleting sandboxes or images
  from the UI; creating sandboxes from the UI; a Dock icon or main window; a
  viewer for a sandbox's desktop; Developer ID and notarization; Intel Macs;
  migration from the current install.
