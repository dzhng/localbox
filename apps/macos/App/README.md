# Localbox.app

The menu bar app: it supervises the VM daemon and the connector, draws this
Mac's state in a popover from its status item and, in later slices, installs
updates. The plan and its
rationale are in [specs/menu-bar-app](../../../specs/menu-bar-app/README.md).

## Ownership rules

- **The app is a supervisor and a view, never a second implementation.** Every
  read and every action is one invocation of the CLI inside the bundle
  (`BundledCLI`). If the app needs a fact or an action the CLI lacks, add it to
  the CLI first.
- **Paths come from the CLI.** `localbox app paths --json` (which also creates
  the machine directories and the IPC token) is the app's only source for any
  path under the machine root or the logs folder. Swift never spells
  `Application Support`.
- **One supervisor.** `ChildProcess` is the only code that starts, restarts or
  stops the daemon and the connector, and `Lifetime` is the only way up and
  down: daemon then connector to start; connector then daemon to stop. A
  child's stop signal is its stdin closing, which also happens when the app
  dies.
- **The daemon is never killed while it may be saving.** Its stop waits
  however long hibernation takes; silence for 120 s earns one SIGTERM, never a
  SIGKILL. One daemon per machine root is the daemon's own lock, not the app's
  bookkeeping.
- **The CLI reaches the app's native powers through one door,** `AppSocket` at
  `<root>/app.sock`, answered by `AppControl`. Anything only the app can do
  (its children's state, the login item, later updates) is an operation there
  that `localbox app` calls, never a second path from the CLI to the app. It
  answers while the daemon is down.
- **`LoginItem` is the only code that registers the app at login,** through a
  `LoginItemDriver`. Only a release build in an Applications folder registers
  by itself, once; tests and probes use the fake driver
  (`LOCALBOX_APP_LOGIN_ITEM=fake`, honoured by development builds only).
- **The daemon's environment is built in one place,** `DaemonLaunch`.
- **Children log straight to files,** never through a pipe the app reads, so
  a child outlives a killed app long enough to stop cleanly. The app reads the
  daemon's progress back from its log.
- **No dependency on the daemon's code.** This package does not import
  `HostDaemonCore`; it knows the daemon only as a process and a few log lines.
- **`LocalboxAppCore` has no UI.** Lifetime and supervision live there so
  tests compile them into small drivers; AppKit stays in the `Localbox`
  executable.
- **The popover's words are made in one place,** `PopoverPresentation`
  (`AppFacts` in, `PopoverRows` out, pure, in `LocalboxAppCore`). The SwiftUI
  views in `LocalboxMenu` lay rows out and hand clicks back as `PopoverAction`s;
  they write no copy and spawn nothing. The executable's `MenuBar` runs each
  action as one `BundledCLI` invocation and opens the popover without
  activating any app. Warnings are the CLI's sentences, shown as they are.
- **Status item art** is a placeholder symbol until `apps/macos/App/art/`
  holds `StatusItem.pdf` and `StatusItemWarning.pdf` (template PDFs); the
  assembler copies them into the bundle and the app prefers them.
- **The bundle layout has one definition,** `scripts/build-app.mjs`, for the
  development build and the release (`--release`), and its signature one,
  `scripts/sign.mjs`: inside out, the virtualization entitlement on the daemon
  alone, and the guest agent sealed as built, never re-signed. The launch
  lock's path comes from the launcher's source; the Info.plist key is copied
  from it.
- **No launchd job.** The app is installed by the agent installation procedure
  and started with `open -g`; it is the only thing that starts the daemon and
  the connector for this Mac's real root.

## Building and testing

```sh
swift build --package-path apps/macos/App
npm run test:app     # Node runners that compile Swift drivers against LocalboxAppCore, and the assembler's checks
npm run app:dev      # npm run build, assemble dist/app-dev/Localbox Dev.app, open it quietly
npm run app:shots    # the popover offscreen for every facts fixture, light and dark, into specs/menu-bar-app/evidence/13
npm run proof -- 41 --tier a   # the packaged app on the process fixture; --tier v with a real VM
npm run proof -- 42 --tier a,v # a scratch-signed release, installed by the installation procedure's own steps
```

A release build (bundle id `sh.localbox.mac`, the update feed in its Info.plist)
is what `scripts/release.sh` assembles and signs. A development build (bundle
id `sh.localbox.mac.dev`, no update feed) uses its
own machine root, `~/Library/Application Support/Localbox Dev`, and its own
logs folder, so it never shares a daemon with a release install. It honours
`LOCALBOX_APP_SCREENS=0` to behave as if the Mac had no display, and
`LOCALBOX_APP_TEST_HOOKS=1` to answer `popover.open`, `popover.close` and
`popover.perform` on the app socket (probes open the popover and use its
actions through them).
