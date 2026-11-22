# Localbox.app

The menu bar app: it supervises the VM daemon and the connector and, in later
slices, draws this Mac's state and installs updates. The plan and its
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
- **The daemon's environment is built in one place,** `DaemonLaunch`.
- **Children log straight to files,** never through a pipe the app reads, so
  a child outlives a killed app long enough to stop cleanly. The app reads the
  daemon's progress back from its log.
- **No dependency on the daemon's code.** This package does not import
  `HostDaemonCore`; it knows the daemon only as a process and a few log lines.
- **`LocalboxAppCore` has no UI.** Lifetime and supervision live there so
  tests compile them into small drivers; AppKit stays in the `Localbox`
  executable.
- **The bundle layout has one definition,** `scripts/build-app.mjs`, for the
  development build now and the release build later.

## Building and testing

```sh
swift build --package-path apps/macos/App
npm run test:app     # Node runners that compile Swift drivers against LocalboxAppCore
npm run app:dev      # npm run build, assemble dist/app-dev/Localbox Dev.app, open it quietly
npm run proof -- 41 --tier a   # the packaged app on the process fixture; --tier v with a real VM
```

A development build (bundle id `sh.localbox.mac.dev`, no update feed) uses its
own machine root, `~/Library/Application Support/Localbox Dev`, and its own
logs folder, so it never shares a daemon with a release install. It honours
`LOCALBOX_APP_SCREENS=0` to behave as if the Mac had no display.
