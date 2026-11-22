# Choices made while implementing

Decisions a slice left to the implementer. Each says what, why, and how to reverse it.

## 06 · Daemon: supervised mode, one daemon per root

**The lock is taken first, not just before the socket server.**
`main.swift` takes `MachineLock` before it reads the token, sweeps image
temporaries or builds anything, because `ImageStore.sweepTemps` would also
delete a running daemon's partial writes. Reverse: move `takeMachineLock()`
down to just before `server.start()`.

**The lock file holds the holder's pid**, and the refusal names it
(`another daemon (pid N) holds PATH, …`), so a person or the app can tell which
process to look at. The pid is informational; the `flock` is the lock.
Reverse: drop the `pwrite` in `MachineLock.init` and the pid in
`MachineLockError.held`.

**`machinePaths().hostdLock`** (`<root>/hostd.lock`) is the one definition of
the path on the TypeScript side; `stack.ts` and `realDaemon()` set
`LOCALBOX_HOSTD_LOCK` from it, and slice 08's `DaemonLaunch` should too. The
launchd plist template is untouched: its daemon derives the same path from the
socket's directory, and slice 10 deletes the template. Reverse: remove the
field and set the variable from a literal.

**Stop is one core type, `DaemonShutdown`,** in `HostDaemonCore` rather than in
`main.swift`, so `swift test` drives the real EOF path with the process
fixture. `main.swift` only decides which triggers to install. Reverse: inline
it back into `main.swift` (the tests would then need the binary for every
case).

**The EOF watcher is a thread** blocked in `read(2)` on stdin. Bytes read are
dropped (the supervisor never writes); a read error stops the daemon like EOF,
since the parent can no longer be heard. A `DispatchSource` would do the same
with more code for the EOF case. Reverse: swap the `Thread` for a read source.

**A second stop request is dropped**, not queued: SIGTERM followed by the pipe
closing (an app that signals and then exits) saves once and logs once.
Reverse: remove the `started` guard in `DaemonShutdown.run`.

**Shutdown progress lines** are `hibernated NAME` and `stopped NAME: reason`,
with the daemon's usual `localbox-hostd: ` prefix, after one
`stopping (CAUSE): hibernating running sandboxes` line (CAUSE is `SIGTERM`,
`SIGINT`, `stdin closed`). There is no count line; the app knows what runs from
`app status`. To emit them as each sandbox finishes, `SandboxHost.shutdown`
gained an observer parameter, `finished: (name, failure?)`, defaulting to a
no-op; what shutdown saves, stops and returns is unchanged (the firewall).
Reverse: drop the parameter and print from the returned actions at the end.

**Unknown arguments exit 64** (`usage: localbox-hostd [--supervised]`), so a
typo such as `--supervise` cannot start a daemon that silently outlives its
app. Reverse: ignore unknown arguments again in `supervisedArgument()`.

**Probe 40 no longer uses the spike's app.** It spawns `localbox-hostd
--supervised` directly with a stdin pipe (via `realDaemon().start(bin,
{ supervised: true })` and `closeStdin()`), and is renamed
`40-supervised-daemon.ts`. The app as supervisor is slice 08's to prove with
the real app; the spike's timing table, orphan record and signed-bundle check
were measurements, not regressions, and live in git at 6cd328f. Reverse:
restore `40-app-child.ts` from that commit.

**The rare cold boot after a restore: not reproduced, cause not established,
no fix made.** Spike 02 saw one restore in about 40 fall back to `cold_booted`
with "guest channel is unavailable" after 125 s. That error and that time
mean `GuestLane.open` spent its whole 120 s `guestWait`: every vsock dial was
accepted and then closed before the agent's ready frame (a refused dial would
have said "nothing in the guest accepted vsock port 1024"). 120 s is also two
of socat's 60 s `UNIX-CONNECT` retry windows, which fits the agent's socket
not accepting for two minutes, but rapid closes would end at the same time.

What ran (2026-11-22, this Mac, Colima up, the screen unlocked), with a daemon
instrumented to log each lane attempt and the restore's timings (the
instrumentation was never committed):

- 124 SIGTERM-and-restart cycles of the same 4 × 2 GiB sandboxes, each with
  1280 MiB of random bytes in a tmpfs: 496 restores, all `woke`. Restore to
  attached: median 1.9 s, p99 3.6 s, max 3.7 s. One restore's first dial
  closed before ready (3 ms) and the second dial attached at once: the
  documented "a restored guest closes its first connection" path, seen
  1 in 496.
- 6 cycles of freshly created 4 × 2 GiB sandboxes (the spike's failing
  restore was the first restore of guests booted seconds earlier): 24
  restores, all `woke`. This run was cut short when the session's turn ended
  and was not resumed.
- Probe 40, 10 and 12 runs during the soak: every restore woke.

About 31 minutes of soak machine time, 130 cycles, not the 200 the slice
asked for. Ruled out on this evidence: a steady-state restore race in the
host's lane code or Virtualization's restore at roughly the 1-in-40 rate
seen in the spike (0 in 520 here). Not ruled out: the spike's conditions,
which this run did not recreate (heavy swap from the 8 GiB cells, a blocked
keychain dialog, restores right after a kill -9 mid-save on the same daemon),
and fresh guests (only 24 restores). The guest journal is volatile in the
minimal image (`journalctl --list-boots` finds none), so a fallback leaves
only the restored boot's `console.log`, where the agent's output also goes.

Next step if it recurs: keep the failing sandbox's `console.log` (the agent
logs there via `journal+console`) and the daemon log, and check whether the
agent was down (systemd `start-limit-hit` on `localbox-guest.service` under
`Restart=always`, `RestartSec=0` would leave it down until a cold boot) or
the dials were reset immediately. Reverse: not applicable (nothing changed).

## 07 · CLI: app-managed layout, launcher, home command

- **The old install keeps its link until slice 10.** `reconcileCommand` still symlinks `~/.local/bin/localbox` into
  `releases/active` (states `linked`, `missing`, `elsewhere`, `not_a_link`) when the CLI is an old-install release and
  not in an app, so probe 14 and today's installer keep working. Why: the slice keeps the `cli` field until slice 10,
  and its only caller is that link. Reverse: slice 10 deletes `reconcileLink`, `link()` and `LinkView`.
- **An earlier Localbox launcher is replaced; anyone else's file is not.** The launcher embeds the mark
  `sh.localbox.launcher`; a `different` command carrying it is overwritten, one without it is left alone. Why: the
  slice says `different` is left alone, but then an updated bundle could never refresh the command. Reverse: drop
  the mark check in `reconcileCommand` to leave every `different` file alone, or to always overwrite as Bento does.
- **"Inside an Applications folder" means the app's parent is `~/Applications` or `/Applications`**, the two folders
  the launcher searches (compared as realpaths). Why: a command for an app elsewhere would run a different copy or
  none. Reverse: widen `applications()` in `agent-setup.ts`.
- **Field names.** The command's view (`cli.status`, `produced.command`) is `{ path, state, app, launcher, on_path,
  profile }`; the action subject and the `agents.setup.status` field are `command` (was `cli_link`). A checkout reads
  `not_app_managed` (was `not_a_release`).
- **The PATH block is the app CLI's only.** `AgentSetup` adds it after installing the command and removes it when
  setup is turned off, only for a CLI in an app; the old installer's identical block stays the installer's. The
  command itself stays when setup is turned off (the slice names only the block). Reverse: in `set(false)`.
- **Profiles that are links are edited where they point** (dotfiles checkouts stay links), with the file's mode kept.
  `scripts/localbox-path.sh` replaced the link with a file.
- **Launch failures.** If `open` fails twice, `ensureApp` returns at once with "Localbox could not be started (…);
  open Localbox from Applications" instead of polling 20 s. The socket is polled every 250 ms, each probe bounded to
  1 s. Within one command the launch is attempted once (memoised in `index.ts`). `logout` now reaches the daemon
  through the same `localTransport()`, so it too starts the app. Reverse: `apps/cli/src/app-launch.ts`.
- **Launcher refusals** other than the update conflict use code `internal`: exit 69 when no app is found, 74 for an
  unusable lock or path. The JSON envelope goes to stdout and `code: message` to stderr, as `render` does with
  `--json`. Tests compile with `-DLOCALBOX_ACCOUNT_HOME` and `-DLOCALBOX_SYSTEM_APPLICATIONS`; a release never sets
  them. The launcher exports `LOCALBOX_LAUNCH_LOCK_FD`, `LOCALBOX_LAUNCH_LOCK` and `LOCALBOX_APP` (Bento's names,
  renamed).
- **Where the launcher builds during development:** `npm run build` ends with `build:launcher`, writing
  `dist/launcher/localbox` (ignored). Reverse: drop it from `build`; slice 10's assembler builds its own.
- **`cli-entry.sh` serves two layouts until slice 10:** beside `dist/` (the bundle, Node at `../node/bin/node`) or in
  `bin/` (the release tarball, Node and `dist/` one level up). Reverse: slice 10 deletes the tarball branch.

## 08 · App shell: lifetime and supervision

- **How the dev root is derived.** `packages/config/src/app-bundle.ts` finds the bundle around the running module's
  realpath and reads its `CFBundleIdentifier` from `Info.plist`; `machinePaths(env, app)` gives `sh.localbox.mac.dev`
  the root `~/Library/Application Support/Localbox Dev`. `layout()` uses the same bundle detection (one regex, not
  two). Why: `machinePaths()` is also called by `packages/client`, so the derivation must live in `packages/config`,
  and invariant 7 forbids an environment variable. Reverse: drop the `app` parameter.
- **A dev build's credential lives in its root,** not in `~/.config/localbox/credentials.json`, so a dev app and a
  release app never share a machine identity (the slice says they never share a root). Reverse: in `machinePaths`.
- **Logs.** `machinePaths().logs` is `~/Library/Logs/Localbox` (`Localbox Dev` for a dev build) unless the root is
  relocated (then `<root>/logs`, as probes expect). It was `<root>/logs`, which nothing outside probes read. Files:
  `app.log` (the app's own lines; what it says before `app paths` answers is buffered and written first),
  `hostd.log`, `connector.log`. Reverse: in `machinePaths` and the three names in `main.swift` and `DaemonLaunch`.
- **`app paths` JSON** uses snake_case keys (`ipc_token`, `hostd_lock`) like the rest of the CLI's output, and adds
  `bin_dir` (`AgentSetup`'s command directory, now the exported `commandDirectory`) for the daemon's
  `LOCALBOX_BIN_DIR`. The token is kept when non-empty, else written to a temporary file and renamed (a crash
  leaves no half token). Reverse: `apps/cli/src/app.ts`.
- **The installer's token step** now runs `"$ACTIVE_CLI" app paths` with the root pinned to the token's directory
  (where its plist points the daemon). Its `mkdir` of the machine directories stays until slice 10 deletes it.
- **Children log straight to their files** (opened `O_APPEND`), never through a pipe the app reads: an app killed
  with `kill -9` would leave the daemon writing its shutdown lines into a dead pipe (EPIPE, and Foundation's
  `FileHandle.write` raises on it). The app reads the daemon's lines back by tailing its log every 100 ms. Reverse:
  pipe stdout/stderr in `ChildProcess.spawn`.
- **Any output counts as progress** for the daemon's 120 s rule, not only the two shutdown line shapes. Why: a
  daemon still writing is not wedged. Reverse: filter in `ChildProcess.heard`.
- **`ChildProcess.start()` does not throw**; a child that cannot be launched is retried on the same backoff as one
  that exits. A daemon refused by the lock (exit 75, an orphan still saving) is retried the same way. Reverse:
  rethrow from `spawn`.
- **`Lifetime.pending` is filled from `running`, passed to `stop`,** minus each sandbox the daemon reports. The
  daemon prints no list of what runs (slice 06), and the app has no `app status` yet, so slice 08's app passes
  none and its menu says "Stopping: hibernating sandboxes…". Slice 12 passes the running names from the facts.
  Reverse: drop the parameter.
- **Quit reason.** Logout, restart and shutdown are recognised from the quit Apple event's `kAEQuitReason`;
  everything else is `quit`; `update` is unused until slice 15.
- **`LaunchDecision`** dropped Bento's translocation handling (no move prompt, A10, so it had no consumer);
  `inApplications` is computed from the bundle's own path and logged for slice 12. A dev build never hands off,
  even to another dev copy: their daemons settle it (one per root). Reverse: port `Translocation` back.
- **The no-screen stub** is `LOCALBOX_APP_SCREENS=0`, honoured only by a build without `SUFeedURL`. With no screen
  the status item waits for `didChangeScreenParametersNotification`; supervision starts first regardless.
- **Placeholder UI.** The SF Symbol `shippingbox` (template); menu: `Localbox VERSION` (disabled) and `Quit Localbox`
  (⌘Q). While stopping, the first item reads "Stopping: hibernating …" and Quit is disabled.
- **The dev bundle** is `dist/app-dev/Localbox Dev.app` (name `Localbox Dev`, version from `package.json`, which is
  also `cli/version`). It carries the building Node (`process.execPath`), production `node_modules` installed once
  per `package.json` + `package-lock.json` into `dist/app-cache/`, `release-public.pem`, and `Resources/guest-agent`
  only if `npm run build:guest-agent` ran. Signed ad hoc, inside out. No `LocalboxLaunchLockRelativePath` key yet:
  only Sparkle reads it (slice 15). Debug Swift builds, since probes need the process fixture. Reverse:
  `apps/macos/App/scripts/build-app.mjs`.
- **The app's tests** are Node runners in `apps/macos/App/tests`, run by `npm run test:app`, not by `npm test`
  (each compiles Swift for several seconds). A `BundledCLI`/`DaemonLaunch` runner was added beside the slice's list.
- **Tier `a` harness.** Scratch under `/tmp` (short socket paths); a scratch `HOME` and `LOCALBOX_MACHINE_ROOT`, so
  the bundled CLI never launches an app and nothing touches this account's skill or command. The frontmost app comes
  from `lsappinfo front`; the check is "the app's pid is never frontmost", not "the front app never changes", since
  a person using this Mac may switch apps meanwhile. Processes are found by this run's bundle path (`/private/tmp`
  and `/tmp` both), and quit is SIGTERM, the Quit item's path. The fixture backend needs `node` on the daemon's
  PATH, so tier `a` prepends the running Node's directory to the Finder PATH.
- **`launchctl list` shows the running app** as `application.sh.localbox.mac.dev.…` (LaunchServices' record of a
  running app, not a job). Probe 41 ignores `application.*` labels; the slice's human check
  `launchctl list | grep localbox` shows that one line while the app runs.
- **Tier `a` stands in for hibernation with the fixture's outcome.** The fixture cannot save, so "hibernated before
  the app's pid is gone" is checked as the record's `cold_boot_pending` (the fixture's shutdown outcome) being on disk
  when the daemon exits, and "woke" as `cold_booted` with the fixture's reason. Tier `v` checks the real ones.
- **The supervised connector remembers a revoked secret** and waits for credentials with a different one, so a
  revoked credential still on disk is not retried every 2 s. The unsupervised stop line is now `stopping: signal`
  (was `stopping on signal`). Reverse: `apps/connector/src/index.ts`.
- **`DaemonLaunch`** drops an inherited `LOCALBOX_IPC_TOKEN` (the token is the file `app paths` made) and sets
  `LOCALBOX_GUEST_AGENT` only when the bundle has one. **`BundledCLI`** gives a command 120 s, then SIGTERM.

## 09 · App control: socket, login item, `localbox app`

- **Wire shape.** Request `{"id","operation","params"}`; the answer uses the CLI envelope's words: `{"id","ok":true,
  "result"}` or `{"id","ok":false,"error":{code,message,retryable:false}}` (Bento's `data` became `result`). The id is
  a required non-empty string (`cli-<uuid>` from the CLI) and the client rejects an answer with another id. A
  garbled request is answered `invalid_input` with `id: null`. Codes are the CLI's `ERROR_CODES`. Reverse:
  `AppSocket.respond` and `apps/cli/src/app-socket.ts`.
- **The socket is served once paths are known** (it lives in the root `app paths` names, so `AppPaths` gained
  `app_socket`, `machinePaths().appSocket`), before the children start, and is removed only when the app answers its
  quit, so `app status` shows `stopping`. A socket another live app answers is left alone and only `localbox app`
  is lost (logged); supervision goes on. The handler is synchronous on the socket's queue; slice 15 may need an
  asynchronous answer for Sparkle. Reverse: `serveAppSocket` in `main.swift`.
- **Child states.** `running` = the process is alive (also while it stops); `backing_off` = it exited or failed to
  launch and a restart is scheduled; `starting` = started but not yet launched, which is momentary since `start()`
  launches at once; `stopped` = not supervised. Whether the daemon answers its socket is not the app's to say
  (slice 12's facts). Reverse: `ChildProcess.state`.
- **`ensureApp` waits on the app socket** for `localbox app`, not the daemon's, so `app status` works while the
  daemon backs off. An app that cannot be reached is the retryable `guest_unreachable` every local command already
  gives when Localbox is not running (there is no better code in the contract). Reverse: `askApp`.
- **`app status` is `app.info` with `login_item: { state }` added**, two socket calls. Reverse: `appStatus`.
- **Login item rule.** The defaults key is `loginItemInitialized` (the slice's name). It is set by the automatic
  registration, by an item already enabled or awaiting approval at first launch, and by any `login_item.set` (an
  explicit choice is final, also for a copy outside an Applications folder later moved into one). A failed
  automatic registration, a dev build, or a release outside an Applications folder sets nothing, so a later launch
  can still register. Turning off an item that is not registered does not call `unregister`. Reverse: `LoginItem`.
- **The fake driver in a running app.** A development build honours `LOCALBOX_APP_LOGIN_ITEM=fake` (an in-memory
  item starting disabled), and tier `a`/`v` launches set it: `SMAppService.mainApp` matches by bundle id, so even a
  scratch dev bundle's real login item would be this account's. Reverse: `makeLoginItem` in `main.swift` and the
  env in `scripts/proof/lib/packaged-app.ts`.
- **`login` in an app-managed layout** reports `connector: "supervised"` instead of calling `restartConnectorJob()`.
- **Probe 41 polls `app.info` through the CLI's client directly** for the backing-off window (a CLI process takes
  about as long to start as the 1 s backoff), and checks the end state through `localbox app status`.
- **Not run here:** the slice's manual check on the real account (the dev build in `~/Applications`, `login-item
  on`, relaunch, System Settings, then `off`). It is left for the orchestrator.

## 10 · Release, agent install, and deleting the old path

- **The signature check runs in JavaScriptCore.** The system `openssl` is LibreSSL 3.3.6, which cannot load an
  Ed25519 key (`unsupported algorithm`); `Security.framework` has no Ed25519 key type; CryptoKit needs Swift, which a
  stock Mac lacks; `ssh-keygen -Y verify` checks SSHSIG envelopes, not a raw signature over the manifest's bytes.
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc` is on every Mac and runs modern JS with
  BigInt, so `installation.md` carries a ~70-line Ed25519 (RFC 8032) and SHA-512 verifier. It builds the payload with
  the same `JSON.stringify({ ...manifest, signature: undefined })` as `signManifest`, so it checks exactly the signed
  bytes (a non-ASCII version is in the test), and it also requires `SHA256SUMS` to be exactly the signed digests
  before `shasum -c` checks the zip. Proven on this Mac (macOS 27.0.1) against scratch-key releases and six tampered
  ones (`tests/release.test.ts`), and against a real `release.sh` output (probe 42); the `jsc` path on macOS 14 was
  not checked here. Reverse: once a stock tool verifies Ed25519, replace step 3's script with it.
- **The zip is `Localbox-macos-arm64.zip`**, one name for every version, so the procedure takes all three files from
  `releases/latest/download` with no version lookup (Bento's pattern). Reverse: name it per version and read the
  version from `release.json` first.
- **The release Info.plist carries `SUFeedURL` now** (Sparkle itself, `SUPublicEDKey` and the framework stay slice
  15's). The app treats a bundle with a feed as a release (`LaunchDecision.isRelease`); without it the release would
  never register its login item, hand off to a running copy or refuse the dev-only stubs, and step 7 would be false.
  Nothing reads the feed until Sparkle is linked. Reverse: drop the key in `build-app.mjs` and judge releases by
  bundle id.
- **Both builds carry `LocalboxLaunchLockRelativePath`,** copied from the launcher's `#define` in `main.c` (the one
  source); slice 08 left it out of the dev build. The assembler test and probe 42 check the launcher binary holds the
  same string.
- **The disposable keychain lives in `sign.mjs` (`withIdentity`),** lifted out of `release.sh`, which still reads the
  credentials and passes `--p12/--password-file/--sha1` (or `--identity` for `APPLE_SIGNING_IDENTITY`, `-` for
  `ALLOW_UNSIGNED`). The keychain is never put on the search list (spike 02's scratch identity signed fine without it);
  Bento adds it. `LOCALBOX_RELEASE_PUBLIC_KEY` (new) names the key `release.sh` checks the manifest key against and the
  bundle carries, so a scratch release pins its scratch key; it defaults to the skill's, and the mismatch refusal
  stays. Probes build the throwaway identity with `scripts/proof/lib/scratch-identity.ts`.
- **No hardened runtime and no timestamp on any binary** (Bento's `signReleaseTree` uses neither); the old `release.sh`
  hardened the daemon. Node keeps its JIT with no entitlement, and the daemon boots VMs signed this way (probe 42 v).
  The bundle's own signature seals `Resources/guest-agent`, including the Mach-O darwin tools, without `codesign`
  complaining. The assembler signs the bundle under its staging name, so `signApp` treats the folder it is given as
  the outer bundle whatever it is called.
- **A release build refuses a Node that links libraries outside `/System/Library` and `/usr/lib`** (Homebrew's), and a
  non-arm64 one; `--node` (or `LOCALBOX_NODE_BIN` through `release.sh`) picks another.
- **Proof helpers never ship:** tests import `scripts/proof/lib/installation.ts`, so tsc emits it under
  `dist/scripts/proof`; the assembler skips that folder.
- **The procedure's blocks run as written.** `scripts/proof/lib/installation.ts` cuts the `sh` block out of each
  numbered step; the unit test and probe 42 run steps 2–4 over HTTP (`LOCALBOX_RELEASE_URL`, an override the procedure
  documents) with the scratch key substituted in step 3, in a scratch `HOME` and `TMPDIR`. Each block stands alone
  (state is the download folder in `$TMPDIR`), since an agent's shell rarely keeps variables between calls.
- **Waiting for the old app** uses `osascript -e 'application id "sh.localbox.mac" is running'` before and after the
  slice's `quit app id`, so a copy that is not running is never launched to be quit. Not exercised here: no release
  copy runs on this account. The quarantine check is `xattr -r … | grep com.apple.quarantine` on the unpacked app.
- **Probe 14 is tiers u, a and l.** Tier a installs the dev bundle into a scratch `HOME/Applications` and runs the old
  checks through launches and relaunches; the home command is called with `LOCALBOX_APP` set, since the launcher looks
  only for `Localbox.app` and a dev bundle is `Localbox Dev.app`. Tier l keeps the MCP parity check, which needs the
  local stack (run green in a short clone of this checkout). The release itself is probe **42** (tiers a, v).
- **The connector always waits and stops on stdin EOF.** Proof connectors (`startConnector`) get a stdin pipe held
  (unref'd) by the probe, so they stop with it; DEVELOPMENT.md's manual example pipes `tail -f /dev/null` into it.
  Probe 13's "B removed" check now waits for "waiting for this Mac to be signed in again" instead of exit 0. `login`
  no longer reports a `connector` field.
- **Left in place:** the contract's action kind `linked` (the firewall freezes the contract beyond `cli.status`
  states; nothing produces it now); `launchctl asuser` in `app-launch.ts` and step 5, which is spike 01's launch
  command, not a job; probe 41's `launchctl list` check that no job is added; the `launchctl` calls inside macOS
  guests (`MacBaseBuilder`, `localbox-vmlab`). These are the slice grep's only hits outside `apps/guest-agent/darwin`
  and the spec.
- **Until slice 11 a fresh install has no `linux` image**, so `sandbox create` from the human check fails there;
  `installation.md` already says the app fetches it, as the slice asks.
- **The launcher's lock in the real account.** The packaged smoke and probe 14 run the real launcher, which creates
  `~/Library/Caches/sh.localbox.mac/launch.lock` in this account's real home (by design, from `getpwuid`); nothing
  else touches the real account.
- **Not run here:** the real-account install from `ssh localhost` (the orchestrator's), and a real Gatekeeper
  quarantine case.

## 11 · Built-in image on first launch

- **The probe is `43-builtin-image.ts`**, not the slice's 42 (probe 42 is the release); slice 15's update probe is 44.
  Tier `a` also quits mid-download and relaunches, the slice's human check: the cut part is asked for from its
  partial's length and the finished one not at all. Probe 42 gained one check: the installed app's CLI runs `ensure`
  against `release.sh`'s own output, so the asset names `packImage` writes are the ones `ensure` reads.
- **The install is `replaceLinuxImage`, not `installLinuxImage`.** `ensure` expands into
  `<root>/downloads/linux-<version>/images/linux` and swaps that directory in by rename (the old image set aside as
  `.linux.replaced-<pid>` first, then deleted), so the new image never sits in `<images>` under a sweepable name.
  `installLinuxImage` (probes, `real-daemon.ts`) still clones into `.linux.installing-<pid>` and now ends in the same
  swap. Reverse: in `scripts/release.ts`.
- **"Already current"** is decided from `builtin-image.json`'s `ready` line, which records `version`, `image_sha256`
  (the signed disk digest) and `image_json_sha256`: the same release with an unchanged `images/linux/image.json` asks
  the network nothing (a relaunch, an offline Mac); another release whose manifest names the same disk and
  `image.json` digests fetches only `release.json`. Hashing the multi-GiB disk at every launch was the lost
  alternative; `image.json` alone cannot tell two disks apart (it has no digest). A probe-seeded image has no record,
  so `ensure` replaces it. Reverse: `install` in `apps/cli/src/builtin-image.ts`.
- **`release.json` must name this CLI's version**, or `ensure` fails: a folder override pointing at another release
  never installs that release's image. `checkManifest` is exported for the manifest's own consistency.
- **Where it fetches from.** `LOCALBOX_RELEASE_URL` (the override installation.md already documents) names the release
  folder, any of `https:`, `http:`, `file:`; else `https://github.com/<LOCALBOX_RELEASE_REPOSITORY or
  dzhng/localbox>/releases/download/v<version>`. Any scheme is accepted since nothing is trusted before the signature
  verifies. The key is `Layout.publicKey`: the bundle's `Resources/release-public.pem`, else the skill's.
- **Lock:** `<staging>/lock` holds `pid token`, made with `link(2)` from a draft so it appears whole. It is stale when
  its pid is dead or is not a process whose command line has `image ensure` (pid reuse), and is then taken over; it is
  removed only while it still holds this run's token. A second `ensure` prints the progress file's line and exits
  **75**; `ready` exits 0, `failed` 1. Staging folders of other versions are deleted unless their lock is live.
- **Failures.** A dropped connection is retried 3 times in the run, then the run ends `failed` with the partial kept
  (resumed next time, the offset taken from the file's length); a refusal (wrong length, `Content-Range` that does not
  start where asked, a checksum mismatch, 404) deletes that part. Both are `failed`: the slice has no other phase. A
  stalled connection waits on Node's default 300 s body timeout; not tuned.
- **Progress:** at most one line every 250 ms within a phase, with a trailing write so a stall shows the last bytes;
  every phase change and every finished part is written at once. `downloading` counts the artifacts' bytes (parts, boot
  store, `image.json`); `expanding` the disk's bytes expanded (`expandImage`'s new callback, after each chunk);
  `installing` and `ready` carry the image's size. Each line is written to `builtin-image.json` by rename.
- **`expandImage`** now removes `.<name>.partial-<pid>` temporaries whose pid is dead, beside its destination.
- **Supervision.** `ChildProcess` gained `Restart.untilSuccess` (exit 0 ends supervision; a later `start()` runs it
  again) instead of a second supervisor. The one-shot runs `localbox app image ensure --json` into `<logs>/image.log`,
  with `StopPolicy.imageEnsure` (SIGTERM at once: `ensure` does not watch stdin, because a shell often starts it with
  stdin closed) and `Backoff.imageEnsure` (5 s doubling to 300 s, reset after a 10 min run). `Lifetime` starts it after
  the daemon and the connector and stops it after the connector, before the daemon. Every launch runs it, which covers
  the relaunch after an update; `Lifetime.ensureImage()` is the hook for slice 15 should a change of release arrive
  without one. Reverse: `ChildProcess.exited`, `Lifetime`.
- **The daemon's refusal is gated on `LOCALBOX_BUILTIN_IMAGE_PROGRESS`**, which only `DaemonLaunch` sets (to `app
  paths`' new `builtin_image`). Under the app a new create from `linux` with no `images/linux` is `sandbox_not_ready`,
  `retryable: true`, details `{ state: downloading|failed, image, phase, progress? }`, on every backend (so probe 41's
  fixture tier now seeds a stand-in `images/linux`); a create re-run for a sandbox already here is not refused. With
  no app (probes starting the daemon directly) a missing image is still `image_not_found`. A failed download is
  refused retryable too, since the app keeps retrying. The daemon's envelope gained a `retryable` argument (it was
  always false). The relay already passed a settled machine refusal through and released the reservation; a test now
  pins it.
- **Paths.** `machinePaths()` gained `downloads` and `builtinImage`; `app paths` prints `builtin_image`; Swift
  `AppPaths.builtinImage`. `app status` reads the progress file from `machinePaths().builtinImage`.
- **Warning fixes made true:** `builtin_image_missing` "Quit Localbox and open it again to download it, or run
  localbox app image ensure."; `builtin_image_failed` "Localbox keeps trying; check this Mac's internet connection."
- **Tier `a` never reaches GitHub:** `packagedApp` launches with `LOCALBOX_RELEASE_URL` on an empty scratch folder,
  so the launch-time `ensure` fails at once (probe 41's status then shows `builtin_image: failed` behind
  `signed_out`); probe 43 passes its fault server instead. `Processes` gained `imageEnsures`, which cleanup kills.
- **Fixture images are 32 MiB:** APFS allocates a file of 16 MiB or less whole, so a smaller one cannot show holes.
  The fault server and the signed fixture release live in `scripts/proof/lib/image-release.ts` (tests and probe 43).
- **Not run here:** the slice's manual run against a real published release (time and peak disk). No release in this
  manifest shape is published yet (v0.1.1 is the older one), so it waits for the first release cut with `release.sh`.

## 12 · App facts: the one state shape

- **One additive daemon change, to `host.watch`** (internal, not in the catalog): each sandbox row gains `name`, `os`
  and `lifecycle` (the raw runtime state, since the catalog's `sleeping` hides paused versus saved to disk), and the
  answer gains `operations`, `HostOperationStore.current()`: every running operation plus each image's latest one when
  it failed, as `image.wait` shows a record, with `sandbox: { sandbox_id, name }` on a create waiting for its copy (only
  its checkpoint knows the name). Why: the daemon has no local `image.list` (that is the account's), and one answer
  keeps `app status` to two daemon calls (`host.watch`, `relay.status`) instead of `sandbox.list` plus an
  `image.wait` per image. Reverse: drop the fields and compose `sandbox.list` and `image.wait`.
- **`watch_version` is a fingerprint of the facts** (48 bits of the SHA-256 of everything else), not the daemon's
  version. `--since N` waits until the facts differ from N, so a change the daemon does not announce (the app's
  children, the login item, a sign-in, image progress, `builtin-image.json`) also ends the wait. While waiting, the CLI
  long-polls `host.watch` on the daemon's own version in 2 s slices and recomposes between them; with the daemon down
  it rechecks every second. `checkHost()` and agent setup (they spawn processes) are read once per invocation.
  Reverse: `appFacts` in `apps/cli/src/app-facts.ts`.
- **States.** `daemon`: `running` when the daemon answers; the app's child state otherwise, with an app-side `running`
  that does not answer reading `starting`. `connector`: `signed_out` without credentials or when the relay reports
  `revoked` (with the account still named); `down` when the app's child is not running or its last report is stale;
  `connecting` when it has not reported yet or the daemon is down. Sandbox states map the daemon's lifecycle
  (`ready`/`freezing` running, `paused`, `asleep`, `starting`, `stopping`/`stopped` stopped, `error` failed).
  `capacity.cpus_free` is cores minus the CPUs of running sandboxes (the daemon reserves memory, not CPUs);
  `memory_free_bytes` is the admission room.
- **Images by id.** The daemon knows images only by id, so `images[].name` is the id (`linux` for the built-in).
  An image already in the images folder is not listed (this also leaves out the sending side of a copy). A failure
  (image or waiting sandbox) shows for an hour after it ended; a cancelled create (its sandbox was deleted) never.
  Failed rows carry `error` (the record's message), a field the slice did not name.
- **`account.email`** comes from the credential: `localbox login` now writes the `email` it was given (the account
  itself holds only a generated name). Credentials written before this have none and show `email: null`.
- **Warnings, most severe first:** `daemon_down` (not while quitting), `signed_out` / `connector_down`,
  `builtin_image_failed` / `builtin_image_missing`, `hibernate_blocked` (fix: `checkHost().fixes` joined with
  "; then "), `not_in_applications` (release builds only: a dev build always runs from where it was built),
  `login_item_needs_approval`, `command_not_installed` (agent setup on and the command `missing` or someone else's
  file; an app outside Applications is `not_in_applications`'s). `builtin_image` reads `builtin-image.json` when
  present, but `ready` there with no `images/linux` is `missing`.
- **An app that cannot be reached** is the error slice 09 gave (`guest_unreachable`, or `unsupported` outside an app):
  the facts start from the app socket. `appStatus` in `app.ts` is gone; `app status` is `appFacts`.
- **`FactsSource`** publishes a value only when its `watch_version` changes (that is the debounce). Watching, it reads
  once without `--since` and then long-polls; a failure is retried after 2 s watching, 60 s idle. Not watching, it
  cancels the poll (`BundledCLI.run` is now cancellable: SIGTERM to the child, `CancellationError`) and reads every
  60 s. The app stops it as soon as a quit begins, since a read after the app socket closes could start another copy
  of the app. `Lifetime.stop` gets `facts.latest.hibernating` (running and paused names, what the daemon saves). The
  popover and Settings are what will call `setWatching`; until slice 13 nothing does.
- **Swift `AppFacts`** uses strict enums for every closed state, so a new CLI state fails the shared-fixture test
  instead of decoding silently; `agent_setup.command`/`skill` and warning codes stay strings. `update` is not decoded
  until slice 15. The fixture test re-encodes each fixture and compares it (nulls dropped) to the file.
- **Probe 41 tier `a` sees `paused`, not `asleep`.** The process fixture cannot save its state, so its sleep is
  SIGSTOP and the facts truthfully say `paused`; the check is that the long poll answers with the new state well
  before its 25 s timeout. `asleep` needs a real VM (tier `v`, not extended here). The probe saves its `app status`
  sample to the run's evidence folder.

## 13 · Popover

- **The Bento reference was rendered, not read off the code.** `git archive` of Bento at the frozen commit into
  scratch, then its own `compileControlsCheck` and `tests/fixtures/capture-view.swift` (a small runner in scratch,
  since the export has no `.git` for `capture-view-shots.mjs`'s revision record) built `BentoControls` and drew every
  capture state on this Mac (macOS 27, no Sparkle needed). `idle.png` is `assets/bento-popover.png` (1x, Bento's own
  dark backing; Bento's shots, like ours, do not composite native glass).
- **Chrome taken from Bento:** 352 pt wide; 16 pt outer padding; a 30 pt mark and 16 pt semibold title at the top;
  11 pt medium secondary section labels; 12 pt rows with a 10 pt secondary second line, 48 pt tall, icon at x 22;
  Bento's banner (orange 18 % fill, 55 % stroke, radius 8, 10 pt inset) for the warning band; a full-width separator
  over a footer whose Quit sits 28 pt from the right edge; NSPopover's own material and corners behind a transparent
  SwiftUI view. Row text sits at x 50 and titles at x 58 because that is where Bento's NSTextField glyphs land (2 pt
  field inset), not where its frames start.
- **Compare (header band plus first row, dark, 1x; `evidence/13/compare/`):** landmarks match: mark, title, section
  label, row text and Quit ink within 1 px of Bento's. Pixel numbers (mae 13.7, pixelmatch 0.10, edge-energy ratio
  1.63) are content (Bento's source tiles vs our rows) and decided nothing. One deliberate deviation: Bento's section
  label renders at about 80 % white although its code asks for `secondaryLabelColor`; ours uses the system secondary
  (about 55 %, the same as Bento's footer). Verdict: chrome matches; accepted.
- **Critique (one unprimed agent, all 28 shots and 9 crops, no context):** fixed: the twelve-row list ended mid-row with
  no cue (the capped list now fades its last 36 pt when it overflows); Settings… disabled in every state (hidden until
  slice 14 has a window: `Local.settingsAvailable`); a stale "Connecting…" while quitting (the header says
  "Quitting…"); the empty line indented past its label; bars ending at no edge and icons drifting in taller rows (bars
  and errors now run under the text to the row's edge, the icon centres on the two text lines); the red error with no
  icon; grey-on-orange fix text (75 % primary now); uneven gap before "Images in progress"; "Copying · receiving · 43%"
  against a sandbox's "Copying 43%" (now "Copying 43% · receiving"); the badge a size larger. Declined: the warnings'
  own sentences (the band says "Sign in from Settings", the hibernate fix runs on, no monospace for the command) are
  the CLI's, invariant 10, and Settings arrives with slice 14; the header showing "Connecting…" while the band says the
  daemon is down (both are the facts); asleep, paused and stopped sharing a grey dot (the word tells them apart);
  image names being ids (slice 12); thin row icons and a black, not coloured, badge (template art, placeholder).
- **The words.** Header: the email (or "Signed in" for a credential without one, "Not signed in"), then "Connected",
  "Connecting…", "Offline" (signed out) or "Disconnected" (connector down); room as "Free: 6 of 10 CPUs · 24 of 32 GB
  · 210 GB disk" (memory in powers of 1024 like About This Mac, disk in powers of 1000 like Finder); "Version 0.2.0",
  "(dev)" for a development build. Rows: "Running · Linux", "Copying 43% · Linux" (nearest percent, never 100 % until
  done). Empty states: "No sandboxes on this Mac yet." and, with the daemon not running, "Sandboxes show here once
  Localbox is running." Stopping: "Putting N sandboxes to sleep…" with the names, or "Quitting…" when none are left.
  Before the first read: "Loading…"; a failed start: "Localbox couldn't start. Quit it and open it again."
- **Menus.** Wake runs `sandbox start NAME` for asleep, paused and stopped; starting, copying and failed rows offer
  only Copy Name and Open Log. The menu is the row's ⋯ button and its context menu (same items).
- **The stopping state comes from the app, not the facts:** `FactsSource` stops as a quit begins, so `MenuBar.quitting`
  feeds `Lifetime`'s pending names into `PopoverPresentation.Local.quitting`, which outranks `facts.stopping`.
- **Open Log** writes the `lines` of `sandbox logs NAME --json` to `$TMPDIR/Localbox Logs/NAME.log.txt` and opens it
  with the default app for plain text (`.log` alone would open Console). That app activates, which is the point.
- **A failed action's message** is kept by sandbox name and cleared by the next published facts. Since `FactsSource`
  publishes only on a new `watch_version`, a refusal that changes nothing stays until something else changes.
- **Popover host.** `NSPopover`, `.transient`, not animated, sized by `NSHostingController.sizingOptions =
  .preferredContentSize`; it never calls `NSApp.activate`. A global mouse-down monitor and Esc close it, as Bento's
  does, since a menu bar app is usually not active and `.transient` then misses outside clicks. Not run here: clicking
  the real status item (the orchestrator's `app:dev` check).
- **The list cap is 400 pt** (`PopoverView.listLimit`), measured by a preference on the content; header, band and
  footer stay outside the scroll.
- **Test hooks:** `popover.open`, `popover.close`, `popover.perform {action, name}` on the app socket, answered only by a
  development build launched with `LOCALBOX_APP_TEST_HOOKS=1` (the tier `a`/`v` harness sets it). `perform` refuses
  (`conflict`) an action the popover does not offer for that row now, so the probe goes through the same rows a person
  sees. The frontmost check follows slice 08's: the app's pid is never frontmost while the popover opens and acts.
- **Status item art:** placeholder `shippingbox` symbol; the warning variant cuts a ring and draws an 8 pt dot in the
  corner (template images take no colour). Real art goes in `apps/macos/App/art/StatusItem.pdf` and
  `StatusItemWarning.pdf`; `build-app.mjs` copies them and `StatusIcon` prefers them.
- **View shots** compile `LocalboxAppCore` and `LocalboxMenu` with `swiftc` as static modules targeting macOS 14 (so
  the shots also check the 14 floor), render an `NSHostingView` with no window at 2x on a flat backing (dark is
  Bento's 0.10 grey, light 0.95), and check that every state draws and the twelve-row list is capped. `npm run
  app:shots`; not part of `npm run test:app`. Extra states beyond the fixtures: `action-failed`, `loading`,
  `quitting`. No fixture was missing: the slice's list was already covered by slice 12's.
- **Probe 41 flake seen once (not this slice's check):** in one of five tier `a` runs, slice 12's `--since` check got an
  answer before the sleep landed (something else changed the facts in its first second), left the sandbox asleep, and
  the later checks that wait for it running failed in turn. The popover check now starts the sandbox itself if it is
  not running. The four other runs, including the last two in a row, were 11/11.
