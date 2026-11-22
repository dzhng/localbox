# 08 · App shell: lifetime and supervision

Needs 06 and 07.

## Contract

`Localbox.app` exists as a development build: an `LSUIElement` app with a bare
status item (version and Quit). It starts the daemon and the connector as
children, restarts them if they crash, and on quit waits for sandboxes to
hibernate before it exits. No launchd job is involved.

## API seam

New SwiftPM package `apps/macos/App` (tools 5.9, `.macOS(.v14)`), with no
dependency on `HostDaemonCore`:

- **`LocalboxAppCore`** (library, no AppKit UI, no Sparkle):
  - `ChildProcess`: a port of Bento's `Sources/Bento/ChildProcess.swift`.
    Restart backoff 1 s doubling to 30 s, reset after 30 s up. Each child has a
    stdin pipe; stopping closes it. Per-child stop policy: the **connector**
    gets close-stdin, 4 s, SIGTERM, 2 s, SIGKILL of its process group; the
    **daemon** gets close-stdin and then an unbounded wait, with SIGTERM only
    if it has printed no shutdown progress for 120 s, and never SIGKILL while
    it is saving (README, invariant 3).
  - `DaemonLaunch`: the one place the daemon's arguments and environment are
    built, from `localbox app paths --json` (added in this slice, see
    below): `LOCALBOX_SOCKET`,
    `LOCALBOX_IPC_TOKEN_PATH`, `LOCALBOX_SANDBOXES`, `LOCALBOX_OPERATIONS`,
    `LOCALBOX_IMAGES`, `LOCALBOX_HOSTD_LOCK`, `LOCALBOX_BIN_DIR`,
    `LOCALBOX_CLI=<bundle>/Contents/Resources/cli/localbox`,
    `LOCALBOX_GUEST_AGENT=<bundle>/Contents/Resources/guest-agent`, logs under
    `~/Library/Logs/Localbox/`.
  - `BundledCLI.run(_ args: [String]) async throws -> Data`: spawns
    `Resources/cli/localbox <args> --json`, stdout to a pipe, stderr to a
    private temp file (Bento's `BundledCLI.swift`), and decodes the CLI's
    failure envelope into a typed error.
  - `Lifetime`: `running → stopping(reason: quit | logout | update, pending:
    [String]) → stopped`. Stop order: connector first, then the daemon.
    `pending` is filled from the daemon's shutdown lines (slice 06).
  - `LaunchDecision.decide(...)`: `.proceed`, `.handOff(pid)` (another release
    copy is running: activate nothing, exit), `.updateRelaunch`. Dev builds
    always proceed. No move prompt (README, A10); `inApplications: Bool` is
    exposed for slice 12's warning.
- **`Localbox`** (executable): `NSApplication` with
  `setActivationPolicy(.accessory)`, one `NSStatusItem`, an `NSMenu` with the
  version and Quit for now (slice 13 replaces it with the popover).
  `applicationShouldTerminate` returns `.terminateLater` until `Lifetime` is
  `stopped`. SIGTERM is routed to the same orderly quit.
- **CLI:** `localbox app paths --json` (new file `apps/cli/src/app.ts`) returns
  `machinePaths()` as JSON and is the only creator of the machine directories
  and the IPC token (0600), replacing the installer's token step.
- **Connector** (`apps/connector/src/index.ts`): with `LOCALBOX_SUPERVISED=1`,
  `runConnector` waits for credentials to appear (checking every 2 s) instead of
  returning 0 when signed out, loops again after `RevokedError`, and exits when
  stdin closes. Without the variable it behaves as today, until slice 10
  removes the launchd job.
- **Dev build:** `npm run app:dev` builds the package, assembles a dev bundle
  (id `sh.localbox.mac.dev`, no `SUFeedURL`) and opens it. A dev build uses its
  own machine root, `~/Library/Application Support/Localbox Dev`, which its
  bundled CLI derives the same way (from the dev bundle id in its layout), so
  a dev app and a release app never share a root.

## What the human can run

`npm run app:dev`, then `localbox app paths --json`, create a sandbox through
the dev bundle's CLI, choose Quit: the status item stays until the sandbox has
hibernated; `pgrep localbox-hostd` is then empty. Reopen: the sandbox reports
`woke`. `launchctl list | grep localbox` is empty throughout.

## Verification

- Node runners that compile small Swift drivers against the production sources
  in scratch `HOME`s (Bento's pattern, `apps/macos/tests/child-process.test.mjs`
  and `launch-decision.test.mjs`): backoff and reset; process-group kill for
  the connector; the daemon is never SIGKILLed while printing progress;
  `Lifetime` ordering with fake children; `LaunchDecision` cases.
- `node:test`: `app paths` creates the directories and token once; connector
  waits for credentials, loops after a revoke, exits on stdin EOF.
- **New proof tier `a`** (README, A13) in `scripts/proof/run.ts`, with
  `scripts/proof/lib/packaged-app.ts` (`start`, `stop`, `cli`, `waitForSocket`;
  Finder-like environment; scratch root; `open -g`; asserts the frontmost app
  never changes). Probe `41-app-lifetime.ts`:
  - tier `a` (process-fixture backend): launch, create a sandbox, quit, assert
    the record says hibernated before the app's pid is gone; relaunch, `woke`;
    kill the connector, it restarts; `kill -9` the app, the daemon exits by
    stdin EOF with its sandbox hibernated and a relaunch has exactly one
    daemon; start the app with zero screens stubbed (`NSScreen.screens` empty
    path) and assert supervision still starts.
  - tier `v`: quit and relaunch with a real VM whose marker process survives.

## Delegated to the implementer

File layout inside the package; the status item's placeholder glyph; log file
names; the dev root's exact directory name; how the tier `a` harness detects
the frontmost app.

## Must stay green

Every existing probe (they start the daemon with no app); `swift test` for
`HostDaemon`; connector unit tests.

## Feedback that would change this slice

Spike 02's timing table showing hibernation regularly exceeds a minute: then
the 120 s no-progress rule is revisited with the user before coding.
