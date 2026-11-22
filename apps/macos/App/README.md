# Localbox.app

The menu bar app: it supervises the VM daemon and the connector, draws this
Mac's state in a popover from its status item and installs its own updates
with Sparkle. The `localbox` CLI ships inside it. The rationale is in
[specs/done/menu-bar-app](../../../specs/done/menu-bar-app/README.md).

## Principles

Each concept has one owner. A change that needs a second one changes the owner
instead.

- **The app is a supervisor and a view, never a second implementation.** Every
  read is `localbox app status --json` and every action is one invocation of
  the CLI inside the bundle (`BundledCLI`). If the app needs a fact or an
  action the CLI lacks, add it to the CLI first. The powers only a native app
  has (supervision, the login item, Sparkle, drawing) are reachable from the
  CLI through one door, `AppSocket` at `<root>/app.sock`, answered by
  `AppControl`; it answers while the daemon is down, which is how the CLI
  learns that the daemon is down.
- **One supervisor, one way up and down.** `ChildProcess` is the only code
  that starts, restarts or stops the daemon, the connector and the built-in
  image's one-shot; `Lifetime` orders them: the daemon first on the way up,
  the connector first on the way down, so the Mac goes offline before its
  sandboxes stop being served. A child's stop signal is its stdin closing,
  which also happens when the app dies. There is no launchd job: the
  installation procedure opens the app with `open -g`, and from then on it
  opens at login.
- **Quitting takes this Mac offline.** Its sandboxes hibernate and wake at the
  next launch; nothing serves them in between.
- **Hibernation is the daemon's, and the daemon is never killed while it may
  be saving.** The daemon hibernates in its one shutdown path (SIGTERM, stdin
  closed, power-off). The app and the updater only wait for it to exit,
  however long that takes; silence for 120 s earns one SIGTERM, never a
  SIGKILL. One daemon per machine root is the daemon's own kernel lock, never
  the app's bookkeeping.
- **Paths come from the CLI.** `packages/config`'s `machinePaths()` is the one
  definition of the machine root; Swift learns every path from
  `localbox app paths --json` (which also creates the root and the IPC token)
  and never spells `Application Support`. The daemon's environment is built in
  one place, `DaemonLaunch`. A development build gets its own root and logs,
  decided from its bundle id, so it never shares a daemon with a release.
- **Agent setup is the CLI's.** Its `AgentSetup` is the only writer of the
  global skill, `~/.local/bin/localbox` and the PATH block; the home command
  is a copy of the launcher's bytes, never a link into the bundle. Whether a
  CLI is app-managed is decided from its own realpath, never from an
  environment variable. The daemon runs it at every start; the app adds no
  second trigger.
- **The bundle has two writers.** The installation procedure writes it once
  and Sparkle after that; the CLI never downloads a release. Its layout has
  one definition, [`build-app.mjs`](scripts/build-app.mjs), for the
  development build and the release (`--release`), and its signature one,
  [`sign.mjs`](scripts/sign.mjs): inside out, the virtualization entitlement
  on the daemon alone, the guest agent sealed as built and never re-signed.
  The launch lock's path has one source, the launcher's `main.c`; the
  Info.plist key is copied from it.
- **`images/linux` is written only by `localbox app image ensure`,** which the
  app runs at every launch as a one-shot child, after the signed manifest and
  every digest verify against the one pinned public key.
- **Warnings are computed once,** in the facts the CLI returns. The popover
  and Settings render them as they are and write none of their own.
- **The words are made outside the views.** `PopoverPresentation` turns
  `AppFacts` into `PopoverRows` and `SettingsModel` holds Settings' facts and
  form, both pure and in `LocalboxAppCore`; the SwiftUI views in
  `LocalboxMenu` lay them out and hand clicks back, and spawn nothing. The
  popover opens without activating any app. Settings' layout follows the
  reference shots in `specs/done/menu-bar-app/assets/`; its one setting of its own
  is "Show this window when Localbox starts".
- **`LoginItem` is the only code that registers the app at login,** through a
  `LoginItemDriver`. Only a release build in an Applications folder registers
  by itself, once; after that the person's choice stands. Tests and probes use
  the fake driver (`LOCALBOX_APP_LOGIN_ITEM=fake`, development builds only),
  since `SMAppService` matches by bundle id and a scratch bundle's real item
  would be this account's.
- **Sparkle is the only updater, and `UpdateCoordinator` the only gate.**
  Sparkle (patched, built from source in [`sparkle/`](sparkle/), linked only
  when `LOCALBOX_SPARKLE_FRAMEWORK` names it) owns the feed, the schedule, the
  verified download and the replacement; `SparkleDriver` shows no Sparkle UI.
  The coordinator grants Sparkle's permit only after the slow part is over: no
  blocker, the children stopped through `Lifetime` (the daemon hibernating
  however long it takes), and no `localbox` command holding the launch lock
  (`LaunchLock`). It then exits well inside the helper's 20 s. Anything that
  fails before the permit restarts the children; there is no rollback.
  Automatic installs wait while sandboxes run and this Mac cannot hibernate
  them; a person's install (Check for Updates, `localbox update install`)
  does not.
- **Children log straight to files,** never through a pipe the app reads, so
  a child outlives a killed app long enough to stop cleanly. The app reads the
  daemon's progress back from its log.
- **No dependency on the daemon's code.** This package does not import
  `HostDaemonCore`; it knows the daemon only as a process and a few log lines.
  `LocalboxAppCore` has no UI, so tests compile it into small drivers; AppKit
  stays in the `Localbox` executable.
- **Status item art** is a placeholder symbol until `art/` holds
  `StatusItem.pdf` and `StatusItemWarning.pdf` (template PDFs); the assembler
  copies them and the app prefers them.

## Building and testing

```sh
swift build --package-path apps/macos/App
npm run test:app     # Node runners that compile Swift drivers against LocalboxAppCore, and the assembler's checks
npm run app:dev      # npm run build, assemble dist/app-dev/Localbox Dev.app, open it quietly
npm run app:shots    # the popover, Settings and its update rows, offscreen, light and dark, into specs/done/menu-bar-app/evidence
npm run sparkle:build          # the patched Sparkle.framework into dist/sparkle (full Xcode, network)
npm run proof -- 41 --tier a   # the packaged app on the process fixture; --tier v with a real VM
npm run proof -- 42 --tier a,v # a scratch-signed release, installed by the installation procedure's own steps
npm run proof -- 44 --tier a,v # N to N+1 through Sparkle, scratch-signed, from a local feed
```

A release build (bundle id `sh.localbox.mac`, Sparkle and its feed keys in its
Info.plist) is what `scripts/release.sh` assembles and signs. A development
build (bundle id `sh.localbox.mac.dev`, no update feed, Sparkle only when
`LOCALBOX_SPARKLE_FRAMEWORK` is set) uses
`~/Library/Application Support/Localbox Dev` and its own logs folder. It
honours `LOCALBOX_APP_SCREENS=0` to behave as if the Mac had no display, and
`LOCALBOX_APP_TEST_HOOKS=1` to answer `popover.*` and `settings.*` on the app
socket (probes open the popover and Settings and use their controls through
them; Settings then orders in behind other windows instead of activating).
