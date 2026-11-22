# Menu bar app: choices ledger

The decisions the agents made on the user's behalf while building the menu bar
app, checked against the shipped code at the end of the build. The user's
decisions (1–12 in the [brief](brief.md)) are not repeated here. An entry
restates one only where the code made a further choice inside it, or where it
is a trade-off the user now owns. The planning-time agent decisions A1–A14 (in
the [README](README.md#plan-decisions)) appear here in their final state when
they are trade-offs the user owns.

This ledger replaces the one appended slice by slice during the build. Entries
a later slice reversed are gone (the old install's command link, the CLI
tarball's layout, the connector's unsupervised mode, `Lifetime.ensureImage()`,
the daemon's fallback lock path). "Until slice N" entries now say how slice N
settled them. Gate results, probe evidence and review narration are gone too;
what the spikes and the real-account proof found is in the README.

**How to read it.** Entries are grouped by verdict:

- **Needs your call:** a trade-off only the user can make. Each names the
  provisional call that ships now and how to reverse it.
- **Unsound:** a choice that breaks a given. Each names the decision to redo it
  from.
- **Provisional:** sound for now, but waiting on something named (a manual
  run, a check on another macOS, art).
- **Sound:** the architecture the user now owns.

Within each group the least confident entry comes first. **Confidence** is how
sure the audit is that the user would have made the same call. **When** names
the slice that made the choice (`review` is the whole-spec review); the
README's [slice table](README.md#where-to-look) says what each slice built. ⚠
marks a choice that stretches or contradicts one of the brief's decisions.

**Review these first:** N1 (a daemon that stops talking while it saves is
waited on forever, with no final kill) and N2 (automatic updates are on by
default). The two Unsound entries the closing audit found were redone and are
now S40 and S41.

---

## Needs your call

### N1. A daemon that goes quiet while saving is waited on forever, with no final kill

**When:** 08, after the closing audit · **Owner:** `StopPolicy.patient` in `ChildProcess.swift`; `Lifetime` (`quiet`); `PopoverPresentation.quietNote`; `DaemonShutdown.run`

Say you quit Localbox with three sandboxes running. The app closes the
daemon's stdin (its stop signal), and the daemon starts hibernating: it saves
each sandbox's memory to disk and prints `hibernated NAME` as each one
finishes. The app waits for the daemon to exit with no deadline, because a save
cut short loses that sandbox's memory, and sends it nothing more. (It used to
send one SIGTERM after 120 s of silence; that did nothing, since the daemon's
shutdown runs once and drops a second stop request, so the step was removed.)

If the daemon writes nothing for 120 s, `Lifetime` marks the stop `quiet` and
the popover adds, under "Putting 3 sandboxes to sleep…": "Saving is taking
longer than usual. Localbox keeps waiting; force-quitting localbox-hostd would
lose the memory of sandboxes not yet saved." Any line from the daemon clears
it, since a daemon still writing is not wedged. The line names the daemon, not
the app, on purpose: the daemon runs in its own process group, so force-quitting
Localbox leaves it saving as an orphan (and the next launch's daemon is refused
by the machine lock until it exits). A daemon truly wedged mid-save (a
Virtualization call that never returns) therefore keeps the app quitting until
macOS ends the session at logout or someone kills `localbox-hostd`. An update
in that state waits the same way.

- **Gap:** the brief said quitting hibernates; nobody said how long to wait.
  Spike 02 measured 4 × 2 GiB at 3.2–10.7 s, so Bento's 4 s + 2 s window was
  too short.
- **Reach:** every quit, logout and update. A deadline would trade a hang for a
  lost sandbox.
- **Verdict:** needs your call: wait forever, or set a final deadline after
  which the daemon is killed. **Provisional call:** wait forever (a hung quit is
  visible, says what is happening, and is recoverable; a killed save is silent
  data loss), and the rule "never SIGKILL a daemon that is saving" stands. To
  reverse it, give `StopPolicy.patient` a deadline after which `ChildProcess`
  SIGKILLs the daemon's process group (a SIGTERM would still do nothing), and
  reword `quietNote`; a sandbox still saving then cold-boots at the next start.
- **Confidence:** low–medium.

### N2. Automatic updates are on by default, check hourly, and wait while sandboxes can't hibernate

**When:** 15 (A12) · **Owner:** `sparkleKeys()` in `build-app.mjs`; `UpdateCoordinator.run`

A fresh install checks `https://localbox.sh/mac/appcast.xml` every hour
(`SUEnableAutomaticChecks` true, `SUScheduledCheckInterval` 3600) and installs
what it finds without asking. Sparkle's own permission prompt never shows: the
no-UI driver answers it "yes, check automatically". Installing an update stops
the connector, then the daemon (which hibernates every running sandbox), waits
for every `localbox` command to finish, and only then lets Sparkle replace the
bundle and relaunch. The sandboxes wake under the new version with their
processes intact.

An automatic install waits instead when sandboxes are running and saving them
could fail right now (S41: the screen is locked and its lock asks for a
password); the Settings line then says so. A person's install (Check for
Updates while one waits, or `localbox update install`) goes ahead and says the
sandboxes may restart.
With automatic updates off, an update still downloads and waits: "Localbox X is
ready. Check for Updates to install it."

- **Gap:** the brief chose Sparkle and copying Bento's "Automatically download
  and install updates" switch, not its default.
- **Reach:** every installed Mac updates itself within an hour of a release,
  briefly offline while it does. A bad release reaches everyone that hour, and
  there is no rollback (brief 9).
- **Verdict:** needs your call. **Provisional call:** on, as Bento ships it. To
  reverse it, set `SUEnableAutomaticChecks` false in `sparkleKeys()` (checks
  then happen only on Check for Updates), or lengthen the interval.
- **Confidence:** medium.

N3 (image rows showed image ids, not names) was fixed after the closing audit
and is now **S42**.

### N4. ⚠ `HOME` is copied into Sparkle's relaunch (stretches 2)

**When:** 15 · **Owner:** `apps/macos/App/sparkle/localbox.patch`

After installing an update, Sparkle's helper relaunches the app. The patch
copies three variables from the running app's environment into that relaunch:
`LOCALBOX_MACHINE_ROOT`, `LOCALBOX_APP` and `HOME`. Bento's patch, which the
brief chose to reuse, carries only its own two names. `HOME` was added because
agent setup decides where the skill and the `localbox` command go from `HOME`,
and LaunchServices refuses to set `HOME` from `LSEnvironment` (it was tried).
Without it, a lab copy launched with a scratch `HOME` would relaunch with the
real one and write this account's skill. For a real install `HOME` is the
account's own both times, so nothing changes.

- **Gap:** the brief's reuse of Bento's patch did not foresee a relaunch that
  must keep a scratch home.
- **Reach:** every update relaunch. It grants the new copy nothing the old one
  lacked.
- **Verdict:** needs your call (it changes Sparkle beyond a rename).
  **Provisional call:** keep it. To reverse it, drop `@"HOME"` from the patch,
  update `patchSha256` in `upstream.json`, rebuild Sparkle, and give probe 44
  another way to keep its scratch home.
- **Confidence:** medium.

### N5. A release build honours `LOCALBOX_RELEASE_URL` and `LOCALBOX_RELEASE_REPOSITORY`

**When:** 11, review · **Owner:** `releaseBase` in `apps/cli/src/builtin-image.ts`

At every launch the app runs `localbox app image ensure`, which downloads the
built-in Linux image for this version. By default it reads
`https://github.com/dzhng/localbox/releases/download/v<version>`. If
`LOCALBOX_RELEASE_URL` is set in the app's environment it reads that folder
instead (`https:`, `http:` or `file:`), and `LOCALBOX_RELEASE_REPOSITORY`
swaps the GitHub repository. This works in a release build, not only a
development one. It adds no trust: nothing fetched is used until `release.json`
verifies against the key sealed in the bundle and names this exact version, and
every artifact matches its signed digest. The worst a hostile value can do is
make the download fail. The installation procedure documents the same
override, and the release probe uses it against a release-built app.

- **Gap:** invariant 7 forbids environment variables for "app-managed"; nobody
  ruled on download locations.
- **Reach:** a local mirror or a test release can feed a real install.
- **Verdict:** needs your call. **Provisional call:** keep honouring it. To
  reverse it, ignore both variables when the bundle is a release (the facts'
  `build`), and give probes 42 and 43 a development-only path.
- **Confidence:** medium–high.

### N6. The app lives in `~/Applications`, and `/Applications` only when a copy is already there

**When:** brief 8 (agent), 10 · **Owner:** `installation.md` step 4; the launcher's search order in `main.c`

The procedure installs to `~/Applications/Localbox.app`, which needs no
administrator, so an agent over SSH can do it with no password (brief 8). It
uses `/Applications/Localbox.app` only when a copy is already there and
writable. The launcher looks in `$HOME/Applications` first, then
`/Applications`; agent setup counts only those two folders as "in
Applications". The trade-off: `~/Applications` is per user (a second account
on the Mac installs its own), and Finder's sidebar shows `/Applications`, so a
person may not find it there.

- **Gap:** the brief delegated the location under "no password".
- **Reach:** every install, the launcher, the login item rule (S12), the
  `not_in_applications` warning.
- **Verdict:** needs your call. **Provisional call:** `~/Applications`. To
  reverse it, have step 4 prefer `/Applications` when it is writable without
  `sudo`, and keep the launcher's two-folder search.
- **Confidence:** medium–high.

### N7. No rollback, no uninstall command, no move-to-Applications prompt

**When:** brief 9, A10, A11; 10, 16 · **Owner:** `UpdateCoordinator`; `installation.md` "Removing Localbox"; `LaunchDecision`

Three things Bento has that Localbox does not:

1. **Rollback** (the user's call, brief 9). A failed update before Sparkle's
   permit restarts the children on the old version; after the permit, Sparkle
   has replaced the bundle and there is no way back but installing an older
   release by hand. The procedure keeps the previous app in a temporary
   folder when it reinstalls, which is the only copy.
2. **An uninstall command** (A11). Removal is a documented sequence:
   optionally `localbox logout`, then `agents setup off`, `skill uninstall`,
   `app login-item off`, quit, delete the app and `~/.local/bin/localbox`, and,
   to leave nothing, the logs, caches, HTTP storage and defaults. The
   `localbox` commands run first, because each would reopen a quit app.
   Sandboxes and images stay until the user deletes the machine root.
3. **A move-to-Applications prompt** (A10). A release copy run from Downloads
   runs and serves sandboxes, but registers no login item, installs no
   command, and shows the `not_in_applications` warning.

- **Gap:** each is a scope call the plan made to keep the app small.
- **Reach:** a bad release can only be fixed forward; a person removing
  Localbox needs the procedure.
- **Verdict:** needs your call. **Provisional call:** as shipped. To reverse:
  a `localbox app uninstall` that runs the sequence before quitting the app;
  Bento's `AppRelocator` behind `LaunchDecision`; rollback would need a kept
  previous bundle and a way to swap it in, which brief 9 ruled out.
- **Confidence:** medium–high.

---

## Unsound

None remain. The closing audit found two, and both were redone:

- **U1** (`localbox login --json` printed text, and Settings read it by exit
  code) is now **S40**: login and logout answer with the CLI's envelope, and
  Settings follows the answer's state.
- **U2** (on a Mac whose lock asks for a password, automatic updates waited
  while any sandbox ran, even with the screen unlocked) is now **S41**: they
  wait only while saving could fail right now.

---

## Provisional

### V1. A restore rarely cold-boots; the cause is unknown and nothing was changed

**When:** spike 02, 06 · **Owner:** `GuestLane.open` (`guestWait`, 120 s); the manual runbook's leg 5

In spike 02, one restore in about 40 came back `cold_booted`: the daemon
restored the VM's saved memory, then waited the full 120 s for the guest agent
to answer and gave up with "guest channel is unavailable", so the sandbox
booted fresh and lost its processes. A later soak of 520 restores (130
SIGTERM-and-restart cycles of four 2 GiB sandboxes) never repeated it. What
that rules out is a steady race at the spike's rate. What it doesn't: the
spike's conditions (heavy swap, a blocked keychain dialog, restores right
after a daemon was killed mid-save) and freshly booted guests. The guest's
journal is not kept across boots in the minimal image, so a recurrence leaves
only the restored boot's `console.log`.

- **Gap:** no slice could reproduce it.
- **Reach:** any wake after a quit, logout or update may, rarely, lose a
  sandbox's processes.
- **Verdict:** provisional, waiting on evidence. **Provisional call:** ship
  with no fix; the runbook's leg 5 says what to copy the moment it happens, and
  where to look (the guest service hitting systemd's `start-limit-hit`, or
  dials reset at once). To reverse: once the cause is known, fix it there;
  making the guest journal persistent in the image would make the next
  occurrence diagnosable.
- **Confidence:** low.

### V2. The first launch over SSH is proven only by a stand-in

**When:** spike 01, 10, 16 · **Owner:** `installation.md` step 5; `openQuietly` in `apps/cli/src/app-launch.ts`

The procedure opens the app with
`/bin/launchctl asuser "$(id -u)" /usr/bin/open -g "$app"`: `asuser` puts the
`open` in the logged-in person's GUI session, and `-g` keeps it from taking
focus. The CLI's quiet launch uses the same command. This Mac had no SSH key
login to itself, so every run (spike 01, the release probe, the real-account
proof) used a detached shell with a stripped environment as a stand-in for an
SSH session. That worked every time, also with the screen locked, but a real
`ssh` session differs in ways the stand-in may not reproduce (its audit
session, its bootstrap namespace).

- **Gap:** no second machine with key login.
- **Reach:** brief 8's promise that an agent installs Localbox remotely.
- **Verdict:** provisional, waiting on the runbook's leg 4 (a true SSH install
  from another machine). If `open` fails from real SSH, the fallback needs the
  user's sign-off, since the obvious one is a launchd job.
- **Confidence:** medium.

### V3. The installer verifies the release in the system `jsc` shell, checked only on macOS 27

**When:** 10 · **Owner:** `installation.md` step 3; `tests/release.test.ts`

Step 3 must check `release.json`'s Ed25519 signature before trusting
anything, on a stock Mac with no Node. The system `openssl` is LibreSSL, which
cannot load an Ed25519 key; Security.framework has no Ed25519 key type;
CryptoKit needs a Swift toolchain; `ssh-keygen -Y verify` checks a different
envelope. So the procedure carries a 70-line Ed25519 and SHA-512 verifier in
JavaScript and runs it with
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`,
a JavaScript shell that ships inside macOS but is not a documented tool. It
checks exactly the bytes the release signed, and that `SHA256SUMS` lists
exactly the signed digests. It is tested against good and tampered releases,
but only on macOS 27; the minimum is macOS 14 (A14).

- **Gap:** no stock macOS tool verifies Ed25519.
- **Reach:** every install. If Apple moves or removes `jsc`, step 3 fails
  closed (no install), it never passes a bad release.
- **Verdict:** provisional, waiting on a run of step 3 on macOS 14 and 15.
  To reverse: replace the script with a stock tool once one verifies Ed25519,
  or sign releases with a second, ECDSA P-256 signature that Security.framework
  can check.
- **Confidence:** medium.

### V4. Whether a turned-off login item leaves a record in System Settings is unknown

**When:** 16 · **Owner:** `installation.md` "Removing Localbox"

Removal runs `localbox app login-item off`, which unregisters
`SMAppService.mainApp`; `SMAppService` then reports `disabled`. Whether System
Settings › General › Login Items keeps a greyed-out "Localbox" entry after the
app is deleted could not be checked: listing Background Task Management's
records (`sfltool dumpbtm`) needs an administrator.

- **Gap:** no administrator in an agent session.
- **Reach:** what a removed install leaves behind.
- **Verdict:** provisional, waiting on one look at System Settings (or
  `sudo sfltool dumpbtm`) after a removal. If a record lingers, the procedure
  says so; there is no unprivileged way to delete it.
- **Confidence:** medium.

### V5. The update probe's packaged tier has no sandbox

**When:** 15 · **Owner:** `scripts/proof/probes/44-installed-update.ts`

Probe 44 proves an update from version N to N+1 through the real patched
Sparkle, from a local feed signed with a scratch key. Its tier `a` (the
packaged app on the process fixture, no real VM) runs the whole cycle without a
sandbox, because Sparkle's relaunch gives the app no `PATH` with Node, which
the fixture's fake guest needs. So tier `a` proves the gate, the lock, the
replacement and the relaunch, not that a sandbox survives. Tier `v` (a real
VM) does, and the real-account proof did too (a counting process kept its
count across 0.16.0 → 0.16.1).

- **Gap:** the fixture's dependency on Node.
- **Reach:** a regression in "sandboxes survive an update" is caught only at
  tier `v`.
- **Verdict:** provisional. To reverse: give the fixture an absolute Node path
  in its sandbox record, so tier `a` can carry a sandbox through the relaunch.
- **Confidence:** medium–high.

### V6. The status item is a placeholder symbol

**When:** 13 · **Owner:** `StatusIcon` in `LocalboxMenu`; `apps/macos/App/art/`

The menu bar shows SF Symbols' `shippingbox` as a template image; with a
warning it cuts a ring and draws an 8 pt dot in the corner (template images
take no colour). `build-app.mjs` copies `art/StatusItem.pdf` and
`art/StatusItemWarning.pdf` when they exist, and the app prefers them.

- **Verdict:** provisional, waiting on art. Adding the two PDFs is the whole
  change.
- **Confidence:** high.

---

## Sound: trade-offs and shapes you now own

### Lifetime and supervision

#### S1. Quitting takes the Mac offline; there is no background service

**When:** 08 (brief 1) · **Owner:** `Lifetime`, `ChildProcess`

The app starts `localbox-hostd --supervised` and `localbox connector run` as
children, each with a stdin pipe. Closing a child's stdin is its stop signal,
and the kernel closes it when the app dies too, so a `kill -9` of the app
still stops its children. On the way up the daemon starts first (the
connector finds its socket sooner); on the way down the connector stops first,
so the Mac leaves the account before its sandboxes stop being served. A
release has no launchd job; a LaunchAgent whose binary changes on update is
refused by macOS under a self-signed identity (Bento's dead end), which is why
children are app-supervised.

- **Verdict:** sound. **Confidence:** high.

#### S2. Restarts back off from 1 s to 30 s; a child that cannot launch is retried the same way

**When:** 08, 11 · **Owner:** `Backoff`, `ChildProcess.start`

A child that exits is restarted after 1 s, doubling to 30 s, and the delay
resets once it has stayed up 30 s. A child that fails to launch at all, or a
daemon refused by the machine lock (exit 75, an orphan still saving), is
retried on the same schedule; `start()` never throws. The built-in image's
one-shot uses 5 s doubling to 300 s, reset after 10 minutes, so a Mac offline
for a day does not ask GitHub every 30 s.

- **Verdict:** sound. **Confidence:** high.

#### S3. Children log straight to files, and the app tails the daemon's log

**When:** 08 · **Owner:** `ChildLaunch.log`, `LogTail`

Each child's stdout and stderr are appended to its own file
(`hostd.log`, `connector.log`, `image.log`), never piped through the app. If
the app is killed, a daemon writing its shutdown lines into a dead pipe would
get EPIPE. The app reads the daemon's progress (`hibernated NAME`) by tailing
`hostd.log` every 100 ms. Logs live in `~/Library/Logs/Localbox`
(`<root>/logs` when the root is relocated); the app's own lines go to
`app.log`, buffered until `app paths` names the folder.

- **Verdict:** sound. **Confidence:** high.

#### S4. One daemon per machine root, by the daemon's own lock, taken before anything else

**When:** 06, review · **Owner:** `MachineLock`; `takeMachineLock()` in `localbox-hostd/main.swift`

The daemon takes an exclusive `flock` on `<root>/hostd.lock` before it reads
the token or sweeps image temporaries, because the sweep would delete a
running twin's partial writes. The lock file holds the holder's pid, and the
refusal names it. `LOCALBOX_HOSTD_LOCK` is required (exit 78 without it), so
`machinePaths().hostdLock` is the path's only definition. An unknown argument
exits 64, so a typo like `--supervise` cannot start a daemon that outlives its
app.

- **Verdict:** sound. **Confidence:** high.

#### S5. The daemon stops once, in one path, and reports each sandbox as it goes

**When:** 06 · **Owner:** `DaemonShutdown`

SIGTERM, SIGINT and the end of stdin (for a supervised daemon) all run the
same steps once: stop taking requests, hibernate every running sandbox, exit
0. A second request is dropped. It prints `stopping (CAUSE): hibernating
running sandboxes`, then `hibernated NAME` or `stopped NAME: reason` per
sandbox. `SandboxHost.shutdown` gained an observer for those lines; what it
saves and returns is unchanged. Because a second request is dropped, the app
sends nothing after closing stdin (N1).

- **Verdict:** sound. **Confidence:** high.

#### S6. Logout, restart and shutdown are told apart from a plain quit, and act the same

**When:** 08 · **Owner:** `AppDelegate.reason()`

The quit Apple event's `kAEQuitReason` marks logout, restart and shutdown as
`logout`; everything else is `quit`; an update's stop is `update`. All three
stop the children the same way and hold the app's termination until the
daemon exits. Only an update's stop can be undone (`Lifetime.restart()`), when
the update does not install. How long macOS waits at a real logout is the
runbook's leg 1.

- **Verdict:** sound. **Confidence:** medium–high.

#### S7. Supervision never waits for a screen

**When:** 08 · **Owner:** `showStatusItemOnceAScreenExists`

On a Mac with no display, the app starts its children at once and attaches
the status item when a screen appears. A development build can pretend there
is none (`LOCALBOX_APP_SCREENS=0`). Whether a headless Mac comes up through
the login item is the runbook's leg 2.

- **Verdict:** sound. **Confidence:** high.

#### S8. A second release copy hands off; development builds never do

**When:** 08 · **Owner:** `LaunchDecision.decide`

A release launched while another release copy runs exits at once. A
development build has its own bundle id and machine root, so it runs beside a
release and beside other development copies; their daemons settle it (one per
root). Bento's translocation handling was dropped with the move prompt (N7).

- **Verdict:** sound. **Confidence:** high.

### Paths, identity and builds

#### S9. Only the release bundle id owns the real machine root

**When:** 08, 16 · **Owner:** `stateName` in `packages/config/src/machine-paths.ts`; `appBundle` in `app-bundle.ts`

The CLI finds the bundle around its own realpath and reads its
`CFBundleIdentifier`. `sh.localbox.mac` uses
`~/Library/Application Support/Localbox` and
`~/.config/localbox/credentials.json`. `sh.localbox.mac.dev` uses
`Localbox Dev`, and any other id (a rehearsal or lab build) uses
`Localbox (<id>)`; both keep their credential inside their root. So no build
but the release can share a real install's daemon, sandboxes or machine
identity, and a development build signed in to a test account never becomes
the real Mac.

- **Verdict:** sound. **Confidence:** high.

#### S10. The app learns every path from `localbox app paths --json`

**When:** 08, 09, 11 · **Owner:** `appPaths` in `apps/cli/src/app.ts`; `AppPaths`, `DaemonLaunch`

`app paths` prints the root, credential, token, sockets, lock, folders, logs,
`builtin_image` and `bin_dir` in snake_case, and is the one creator of the
machine directories and the IPC token (32 random bytes, written whole then
renamed). `DaemonLaunch` builds the daemon's whole environment from it, drops
an inherited `LOCALBOX_IPC_TOKEN`, and sets `LOCALBOX_GUEST_AGENT` only when
the bundle has one.

- **Verdict:** sound. **Confidence:** high.

#### S11. A release is a bundle with `SUFeedURL`; a development build is everything else

**When:** 10 · **Owner:** `LaunchDecision.isRelease`; `build-app.mjs`

The app treats a bundle carrying a Sparkle feed as a release: only then does
it register its login item, hand off to a running copy, run Sparkle, and
refuse the development-only switches (`LOCALBOX_APP_TEST_HOOKS`,
`LOCALBOX_APP_LOGIN_ITEM=fake`, `LOCALBOX_APP_SCREENS`). The dev bundle,
`dist/app-dev/Localbox Dev.app`, has no feed, debug Swift builds (probes need
the process fixture), and is signed ad hoc.

- **Verdict:** sound. **Confidence:** high.

#### S12. Open at login registers once, by itself, only for a release in an Applications folder

**When:** 09 (brief 5) · **Owner:** `LoginItem.launched`

The first launch of a release in `~/Applications` or `/Applications`
registers `SMAppService.mainApp` and sets the defaults key
`loginItemInitialized`. After that the person's choice stands: turning it off
in Settings, with `localbox app login-item off`, or in System Settings is
never undone. A failed registration is not remembered, so the next launch
tries again. A development build or a copy elsewhere registers only when
asked. `SMAppService` matches by bundle id, so probes use an in-memory fake
login item.

- **Verdict:** sound. **Confidence:** high.

### The CLI's side

#### S13. The app does nothing the CLI can't, through one socket

**When:** 09, 12 (brief 12, A5) · **Owner:** `AppSocket`, `AppControl`; `apps/cli/src/app-socket.ts`

The app's native powers (the login item, update control, its children's
state) are reachable from the CLI through `<root>/app.sock`: one JSON line in
(`{"id","operation","params"}`), one out in the CLI's envelope words
(`{"id","ok":true,"result"}` or an `error`). The id is required and checked,
so a stale answer is refused. The socket answers while the daemon is down,
which is how `app status` says the daemon is down. It is served before the
children start and removed only when the app answers its quit, so `app
status` shows `stopping`. Every popover and Settings read is
`localbox app status --json`.

- **Verdict:** sound. **Confidence:** high.

#### S14. A command run while the app is quit opens it quietly

**When:** 07 (brief 6) · **Owner:** `ensureApp` in `apps/cli/src/app-launch.ts`

A `localbox` command inside the app that finds no daemon socket runs the
quiet launch (V2's command), retries once after 1 s if `open` fails (spike 02
saw one failure in about 70 right after an exit), then polls the socket every
250 ms for up to 20 s. `localbox app …` waits on the app's socket instead. A
CLI from a checkout, or any run with `LOCALBOX_MACHINE_ROOT` (probes), never
launches an app. A failure is the retryable `guest_unreachable` every local
command already gives when Localbox is not running.

- **Verdict:** sound. **Confidence:** high.

#### S15. The home command is a copy of the launcher, replacing only Localbox's own

**When:** 07 · **Owner:** `reconcileCommand` in `apps/cli/src/agent-setup.ts`; `apps/macos/App/launcher/main.c`

Agent setup writes the launcher's bytes to `~/.local/bin/localbox` (a temp
file renamed into place, 0755), never a link into the bundle, and only for an
app in one of the two Applications folders. The launcher carries the mark
`sh.localbox.launcher`: a different file with the mark (an older launcher) is
replaced, one without it (someone else's `localbox`) is left alone and warned
about.

- **Verdict:** sound. **Confidence:** high.

#### S16. The PATH block is added after the command and removed when agent setup is turned off

**When:** 07 · **Owner:** `addPathBlock`, `removePathBlock` in `apps/cli/src/shell-profile.ts`

When the login shell's startup files do not already put `~/.local/bin` on
PATH, agent setup adds a marked block to the right file. A profile that is a
link (a dotfiles checkout) is edited where it points and stays a link.
`agents setup off` removes the block but leaves the command, which the removal
procedure deletes by hand.

- **Verdict:** sound. **Confidence:** medium–high.

#### S17. The launcher holds the launch lock shared for the CLI's whole life

**When:** 07, 10 · **Owner:** `main.c`; `LocalboxLaunchLockRelativePath` in Info.plist

The launcher takes a shared `flock` on
`~/Library/Caches/sh.localbox.mac/launch.lock` (under the account's real
home, from `getpwuid`, not `$HOME`) and passes the descriptor to the CLI, so
the lock lasts until the CLI exits. Sparkle's patched helper takes it
exclusively while it replaces the bundle; a launcher that finds it held exits
75 ("Localbox is updating; try again in a moment"). Other refusals exit 69 (no
app found) or 74 (an unusable lock or path), each with the CLI's JSON envelope
on stdout. The lock's path has one source, the `#define` in `main.c`, copied
into Info.plist by the assembler.

- **Verdict:** sound. **Confidence:** high.

#### S18. Warnings are decided once, in the facts, most severe first

**When:** 12 · **Owner:** `warnings` in `apps/cli/src/app-facts.ts`

The order: `daemon_down` (not while quitting), `signed_out` or
`connector_down`, `builtin_image_failed` or `builtin_image_missing`,
`hibernate_blocked`, `not_in_applications` (releases only),
`login_item_needs_approval`, `command_not_installed`. Each carries a sentence
and a fix. The popover and Settings render them and write none of their own.

- **Verdict:** sound. **Confidence:** high.

#### S19. `app status --since N` waits for any change, by a fingerprint of the facts

**When:** 12 · **Owner:** `appFacts`; `FactsSource`

`watch_version` is 48 bits of the SHA-256 of all the other facts, not the
daemon's version, so changes the daemon never announces (the app's children,
the login item, a sign-in, image progress) also end a wait. The CLI
long-polls the daemon's `host.watch` in 2 s slices and recomposes between
them, at most 25 s per call. The app long-polls only while the popover or
Settings is open; otherwise it reads every 60 s, so the warning dot stays
true. It stops reading as soon as a quit begins, since a read after the app
socket closes could start another copy of the app.

- **Verdict:** sound. **Confidence:** high.

#### S20. The daemon's `host.watch` gained the rows the facts need

**When:** 12 · **Owner:** `SandboxHost` (`host.watch`, `workInProgress`)

Each sandbox row gained `name`, `os` and the raw `lifecycle` (the catalog's
`sleeping` hides paused versus saved to disk), and the answer gained
`operations`: every running host operation plus each image's latest failed
one, with the waiting sandbox's name on a create waiting for its copy. One
answer keeps `app status` to two daemon calls. `host.watch` is internal, not
in the catalog.

- **Verdict:** sound. **Confidence:** high.

#### S21. Free CPUs are cores minus running sandboxes' CPUs

**When:** 12 · **Owner:** `capacityFact`

The daemon reserves memory, not CPUs, so the popover's "Free: 6 of 10 CPUs"
is the host's cores minus the CPUs given to running and starting sandboxes.
Memory free is the daemon's admission room; disk free is the volume's. Memory
is shown in powers of 1024 (like About This Mac), disk in powers of 1000 (like
Finder).

- **Verdict:** sound. **Confidence:** medium–high.

#### S22. `localbox login` records the email in the credential

**When:** 12 · **Owner:** `login` in `apps/cli/src/index.ts`; `Credentials.email`

The account holds only a generated name, so to show "you@example.com" in the
popover and Settings, `login` now writes the email it was given into the
credential. A credential without one shows "Signed in".

- **Verdict:** sound. **Confidence:** high.

#### S23. The connector waits for credentials, and stops on stdin EOF

**When:** 08, 10 (A3) · **Owner:** `apps/connector/src/index.ts`

Signed out, the connector waits for a credential instead of exiting; after a
revoke it waits for a credential with a different secret, so a revoked one
still on disk is not retried every 2 s. So `login` needs no "restart the
connector" call. It stops when its stdin closes; proof connectors get a pipe
the probe holds.

- **Verdict:** sound. **Confidence:** high.

#### S40. `localbox login` and `logout` answer `--json` with the CLI's envelope (was U1)

**When:** 14, redone after the closing audit · **Owner:** `login`, `logout`, `identityError` in `apps/cli/src/index.ts`; `LoginStep`, `CLISettingsActions` in `SettingsModel.swift`

With `--json`, `localbox login --email E` answers
`{"state": "code_sent", "email": E}` and `--email E --code C` answers
`{"state": "signed_in", "email", "account_name", "machine_name",
"machine_count"}`; `logout` answers `{"signed_out": true, …}` as before.
Refusals from both go through `render()` as the error envelope every other
command prints, with the existing codes: `invalid_input` (no email, a bad email
or code), `conflict` (already signed in), `unauthorized` (a revoked Mac),
`rate_limited` (retryable), `internal`. The identity API's HTTP status picks
the code; the contract and catalog are unchanged. Without `--json` the text is
the same as before ("Code sent to E. Ask the user for the 6-digit code…").
Settings decodes each answer into a `LoginStep` and the code flow follows it:
`code_sent` shows the code field, `signed_in` ends the flow; an exit 0 with any
other answer is shown as a failure, and a refusal shows the envelope's
message.

- **Verdict:** sound (it was unsound while it printed text, contradicting
  brief 12). **Confidence:** high.

### The built-in image

#### S24. The CLI fetches the image at every launch, and only it writes `images/linux`

**When:** 11 (A6, A7) · **Owner:** `ensureBuiltinImage` in `apps/cli/src/builtin-image.ts`

The app runs `localbox app image ensure --json` as a one-shot child at every
launch, which covers the relaunch after an update. It fetches this version's
`release.json`, trusts nothing until its signature verifies against the
bundle's `Resources/release-public.pem` and it names this exact version, then
downloads the image's parts with `Range` resume into
`<root>/downloads/linux-<version>/` (outside `images/`, which the daemon's
start-up sweep cleans), checks each SHA-256, expands the image there and
swaps it in by one rename. A dropped connection is retried three times, then
the run fails with the partial kept for the next run; a wrong answer (a bad
checksum, a `Content-Range` that starts elsewhere, a 404) deletes that part. A
stalled connection waits on Node's default 300 s body timeout.

- **Verdict:** sound. **Confidence:** high.

#### S25. "Already current" comes from a record, not from hashing the disk

**When:** 11 · **Owner:** `install` in `builtin-image.ts`

`builtin-image.json`'s `ready` line records the version, the disk's signed
digest and `image.json`'s digest. A relaunch of the same version with an
unchanged `image.json` asks the network nothing (an offline Mac starts fine);
a new version whose manifest names the same disk fetches only `release.json`.
Hashing a multi-GiB disk at every launch was the lost alternative; `image.json`
alone cannot tell two disks apart. A probe-seeded image has no record, so
`ensure` replaces it.

- **Verdict:** sound. **Confidence:** high.

#### S26. One `ensure` at a time, by a lock file made with `link(2)`

**When:** 11 · **Owner:** `StagingLock`

`<staging>/lock` holds `pid token`, made from a draft with `link(2)` so it
appears whole. It is stale when its pid is dead or is not an `image ensure`
(pid reuse), and is then taken over. A second `ensure` prints the running
one's progress and exits 75. Progress lines come at most every 250 ms within a
phase, with a trailing write so a stall shows the last bytes.

- **Verdict:** sound. **Confidence:** high.

#### S27. Under the app, a create waiting for the image is refused retryable

**When:** 11 · **Owner:** `BuiltinImageWait` in `HostDaemonCore`

`DaemonLaunch` sets `LOCALBOX_BUILTIN_IMAGE_PROGRESS`. With it, a new
`sandbox create` from `linux` while `images/linux` is missing is
`sandbox_not_ready`, `retryable: true`, with the download's phase and
progress, also when the download failed (the app keeps retrying). A daemon
started directly (probes) still answers `image_not_found`.

- **Verdict:** sound. **Confidence:** high.

### Updates

#### S28. Sparkle's feed and archive are signed with the existing release key

**When:** 15 (A9) · **Owner:** `scripts/appcast.ts`; `scripts/release/build.ts`

Sparkle's EdDSA is plain Ed25519, so the build stage signs `appcast.xml` and the
zip with `release-private.pem`, the same key that signs `release.json`, and
`SUPublicEDKey` is its public half. The output is byte-identical to Sparkle's
own `sign_update` for the same seed. There is one trust root and one secret:
losing that key strands every install's updates and installs alike.
`scripts/appcast.ts` writes a one-item feed pointing at the release's versioned
GitHub URL; the zip is the installer's own `Localbox-macos-arm64.zip`, one name
for every version.

- **Verdict:** sound. **Confidence:** high.

#### S29. Everything slow happens before Sparkle's permit

**When:** 15 · **Owner:** `UpdateCoordinator`, `LaunchLock.waitUntilFree`

Sparkle's helper cancels an install unless the app exits within 20 s of the
permit. So the coordinator stops the connector and then the daemon (however
long hibernation takes) while Sparkle waits, then waits until no `localbox`
command holds the launch lock, and only then grants the permit; the app exits
on `updaterWillRelaunchApplication`, within about a second. A failure before
the permit restarts the children. A command that starts between the
coordinator's last lock check and the helper's makes the helper refuse; the
children restart and Sparkle's next check tries again. The built-in image
being swapped in blocks any install. `localbox update check|install` close
their own share of the launch lock before asking, since the install they wait
for waits for every holder.

- **Verdict:** sound. **Confidence:** medium–high.

#### S30. Check for Updates installs an update that is waiting

**When:** 15, 16 (brief 4) · **Owner:** `UpdateCoordinator.check`

Settings copies Bento's General section, which has no Install button. So
Check for Updates (and `localbox update check`) installs an update that is
already downloaded and waiting, as a person's install. The waiting sentence
names that button ("…or use Check for Updates in Settings to install
anyway"). `update check` reports `checking` at once, before Sparkle answers,
so the CLI never reads the last cycle's "You're up to date." while an update
installs.

- **Verdict:** sound. **Confidence:** medium.

#### S31. Sparkle is rebuilt from a pinned commit with the patch re-applied under Localbox names

**When:** 15 (A8) · **Owner:** `apps/macos/App/sparkle/` (`localbox.patch`, `upstream.json`, `build.mjs`)

`npm run sparkle:build` fetches Sparkle 2.10.0 at a pinned commit, applies
`localbox.patch` (the launch lock held through replacement, the relaunch
argument, the relaunch environment of N4), and writes a build receipt.
`build-app.mjs` refuses a framework whose receipt does not match the pin and
the patch's hash. Sparkle's Info.plist keys require a signed feed and verify
the archive before extracting; Sparkle's own automatic installs are off, since
the coordinator decides.

- **Verdict:** sound. **Confidence:** high.

#### S41. Automatic updates wait only while saving sandboxes could fail right now (was U2)

**When:** 15, redone after the closing audit · **Owner:** `screen_locked_now` in `apps/cli/src/app-facts.ts`; `AppFacts.hibernationMayFailNow`; `UpdateCoordinator.run`

The daemon's save fails only while the screen is locked and the lock asks for
a password (`consoleScreenIsLocked()` in the daemon). So the facts carry
`screen_locked_now` beside `hibernate` (the lock *setting*), re-read at every
recomposition so locking or unlocking ends an `app status --since` wait, and
the coordinator's automatic-only blocker fires when sandboxes are running or
paused *and* the screen is locked *and* `hibernate` is not `available`. A
MacBook whose lock asks for a password, in use and unlocked, installs: its
sandboxes hibernate and wake under the new version. Locked, it waits, and
Settings says "Waiting: this Mac is locked, so installing could restart running
sandboxes. Unlock it, or use Check for Updates in Settings to install anyway."
An update waiting on a locked screen goes once the facts say it is unlocked. A
person's install while locked says "running sandboxes may restart".

The unknown case is decided conservatively: a lock setting `host check` cannot
read counts as asking for a password while the screen is locked (the update
waits), and blocks nothing while it is unlocked, since saves work then whatever
the setting. Both sentences say "could" and "may" so they stay true in that
case.

The `hibernate_blocked` warning was checked for the same over-reach and kept:
it is about the setting, which is worth fixing on a Mac meant to free memory
while locked, and its sentence is conditional ("While this Mac is locked, idle
sandboxes can't free their memory, because the lock screen asks for a
password."), so it claims nothing about the screen now.

- **Verdict:** sound (it was unsound while it blocked on the setting alone).
  **Confidence:** medium–high.

### Release and install

#### S32. Signing is inside out, self-signed, with no hardened runtime and no timestamp

**When:** 10 (brief 7) · **Owner:** `signApp` in `apps/macos/App/scripts/sign.mjs`

Every Mach-O file is signed before the bundle that holds it, with no `--deep`
and `--timestamp=none`; only `MacOS/localbox-hostd` gets the virtualization
entitlement; the launcher and Node carry the identifier `sh.localbox.cli`.
Nothing under `Resources/guest-agent` is signed, so the bundle seals those
bytes and their digests still match `agent-version.json`. No binary gets the
hardened runtime, as in Bento: Node keeps its JIT with no entitlement, and the
daemon boots VMs signed this way. The trade-off is that without the hardened
runtime a local process could inject a library into the entitled daemon;
with a self-signed identity and no notarization, that protection was thin
anyway. The PKCS#12 identity is imported into a disposable keychain for one
signing and deleted.

- **Verdict:** sound. **Confidence:** medium–high.

#### S33. A release refuses a Node that a stock Mac can't run

**When:** 10 · **Owner:** `build-app.mjs`

The bundled Node must be arm64 and link only libraries under `/System/Library`
and `/usr/lib`; Homebrew's Node links its own and is refused. `--node` (or
`LOCALBOX_NODE_BIN` through the build stage) picks another.

- **Verdict:** sound. **Confidence:** high.

#### S34. The procedure's blocks stand alone and stop on quarantine

**When:** 10 · **Owner:** `installation.md`; `scripts/proof/lib/installation.ts`

Each numbered `sh` block keeps its state in a download folder under `$TMPDIR`,
since an agent's shell rarely keeps variables between calls; the tests and
probe 42 cut the blocks out of the document and run them as written. Step 4
stops if the unpacked app carries `com.apple.quarantine` (a Gatekeeper dialog
nobody can click would hang every launch), waits for a running copy to quit
with `osascript` (never launching one to quit it), and keeps the old app in a
temporary folder.

- **Verdict:** sound. **Confidence:** high.

### The popover and Settings

#### S35. The popover never activates an app; Settings does

**When:** 13, 14 · **Owner:** `MenuBar`, `SettingsWindow`

The popover is a `.transient` `NSPopover` that never calls `NSApp.activate`;
a global mouse-down monitor and Esc close it, since a menu bar app is usually
not active and `.transient` then misses outside clicks. Opening Settings
activates the app, because a person chose it. Under test hooks Settings orders
in behind instead, so probes never take focus.

- **Verdict:** sound. **Confidence:** high.

#### S36. Per-sandbox actions: Copy Name, Sleep or Wake, Open Log

**When:** 13 (brief 3) · **Owner:** `PopoverPresentation`

Running sandboxes offer Sleep; asleep, paused and stopped ones offer Wake
(`sandbox start NAME`); starting, copying and failed rows offer only Copy Name
and Open Log. Open Log writes `sandbox logs NAME --json`'s lines to
`$TMPDIR/Localbox Logs/NAME.log.txt` and opens it in the default text editor
(`.log` alone would open Console). A failed action's message stays on its row
until the facts next change. The list caps at 400 pt and fades its last row
when it overflows.

- **Verdict:** sound. **Confidence:** medium–high.

#### S37. The popover's and Settings' words are made outside the views

**When:** 13, 14 · **Owner:** `PopoverPresentation`, `SettingsModel` in `LocalboxAppCore`

`PopoverPresentation` turns facts into rows and `SettingsModel` holds Settings'
facts and form; both are pure and tested, and the SwiftUI views in
`LocalboxMenu` only lay them out and hand clicks back. A switch shows its
requested value while its command runs, then whatever `app status` says; a
refusal puts it back and keeps the message. Swift's `AppFacts` uses strict
enums for every closed state, so a new CLI state fails the shared-fixture test
instead of decoding silently.

- **Verdict:** sound. **Confidence:** high.

#### S38. Settings' Account section is Bento's Workspace rows with Localbox's sign-in

**When:** 14 (brief 4) · **Owner:** `SettingsView`, `SettingsModel`

Signed out: an Email field and Send Code on one row. Code sent: "Check your
email / Enter the code we emailed to E." with Use a Different Email, then a
Code field and Sign In. Signed in: the account's email with Sign Out…, which
confirms first, and a "This Mac" row. A revoked Mac (account still named)
shows as signed in, so Sign Out is what it offers; the popover carries the
warning. Settings' only setting of its own is "Show this window when
Localbox starts" (off), never applied on the relaunch after an update.

- **Verdict:** sound. **Confidence:** medium–high.

#### S42. Image work is called by the account's name (was N3)

**When:** 12, fixed after the closing audit · **Owner:** `images:forMachine` in `packages/state/convex/images.ts`; the connector's `mirrorImages`; `ImageStore.accountName`; `SandboxHost.workInProgress`; `imageFacts` in `apps/cli/src/app-facts.ts`

Say you run `localbox image copy my-xcode-base --to studio`. On studio the
popover's "Images in progress" reads `my-xcode-base` with "Copying 43% ·
receiving", and so does `localbox app status` (`images[].name`). The names
live in the account's catalog; the daemon learns them from the mirror it
already had: `images:forMachine` returns each image's name with its holding,
the connector's `image.mirror` call carries it, and `ImageStore` keeps the
latest set in memory beside its listing marks. `host.watch` gives each
operation the account's name for its image as `image_name`, and the facts use
it. A rename re-runs the query, so the connector re-sends and the popover
follows within its two-second recheck (a rename does not bump the watch
version). The same names go into the daemon's messages about a copy that
failed (the receiving side's errors, and a create that waited for the copy),
which the failed rows show. The built-in image stays `linux`.

The holding is made in the account before the Mac is told to build or copy,
so the mirror names the image from the start. The names are not persisted: the
images shown by name are the ones still arriving or building, which have no
image directory to keep a mark in, and the connector re-sends the names as
soon as it reaches the account. After a daemon restart with the connector
offline, an image still in progress reads by its id until then. A build's own
operation never knew the name (the relay hands the Mac only the reserved id),
so it is not a second source.

- **Verdict:** sound. **Confidence:** medium–high.

### Proof harness

#### S39. Packaged-app probes run in scratch homes and never take focus

**When:** 08, 13, 15 · **Owner:** `scripts/proof/lib/packaged-app.ts`; probe 44's lab

Tier `a` launches the assembled app with `open -g` in a scratch `HOME` and
`LOCALBOX_MACHINE_ROOT` under `/tmp`, with the fake login item and test hooks,
and checks that the app's pid is never frontmost (not that the front app never
changes, since a person may be using the Mac). Probe 44 gives each run its own
bundle id `sh.localbox.mac.lab<hex>` and a launcher compiled with that lock
path, because Sparkle's helper resolves the lock under the real home, and
deletes everything under `~/Library` named for that id afterwards.

- **Verdict:** sound. **Confidence:** high.

---

## Compressed: trivial discretion

Internal names and cosmetic calls, banked without entries: the dev bundle's
name `Localbox Dev`; log file names; the app socket's operation names
(`app.info`, `login_item.*`, `update.*`); the test-hook names
(`popover.*`, `settings.*`); popover chrome measured off Bento's rendered
reference (352 pt wide, 48 pt rows); status lines' wording; the
`--localbox-update-relaunch` argument; the contract's unproduced `linked`
action kind, kept because the firewall freezes `packages/contract`; the naming
test's allow-list shape (each entry names its file, term and line, and fails
when it no longer matches).

---

## Release process

Decisions made after the build closed, when `scripts/release.sh` and a
hand-typed `gh release create` became the staged `npm run release -- <stage>`
([runbook](../../../DEVELOPMENT.md#releasing)). Numbered R, in the same
verdict order.

### R1. Needs your call: the smoke runs the real bundle id on this account

**Owner:** `scripts/release/smoke.ts`

The smoke proves the artifact that ships, so it launches the signed bundle
unchanged, as `sh.localbox.mac`, with a scratch `HOME` and machine root. A
release ignores `LOCALBOX_APP_LOGIN_ITEM=fake`, so the smoke launches a copy
outside every Applications folder, where a release registers no login item
(the log line is asserted). Sparkle and the launcher use the account's real
home, so it refuses while any `sh.localbox.mac` runs, and afterwards restores
the `sh.localbox.mac` defaults and deletes the `~/Library` folders it created.
Its Sparkle may reach the real feed during the run; nothing is offered,
because the build is newer than `latest`.

- **Reach:** on a release Mac that also runs Localbox day to day, the owner
  quits it for the smoke (about a minute plus the image's expansion).
- **Verdict:** needs your call. **Provisional call:** the real id, as above.
  To reverse: re-sign a copy under a lab id as probe 44 does, which proves a
  different signature from the one that ships.
- **Confidence:** medium.

### R2. Needs your call: publishing is two commands, draft then `--confirm`

**Owner:** `scripts/release/publish.ts`

`publish` uploads a draft at the built commit, downloads every asset back
and compares its SHA-256, then stops; only `publish --confirm` makes it
public, which creates the tag (so no tag exists for a draft that is thrown
away). `all` stops at the draft. Every install and update follows `latest`
within the hour, so the irreversible step is a separate command a person
types. `--confirm` then waits for the feed redirect and
`releases/latest/download/release.json` to serve the new files.

- **Verdict:** needs your call. **Provisional call:** two commands. To
  reverse: let `all` pass `--confirm` through.
- **Confidence:** medium–high.

### R3. A rehearsal is a mode of the same command, and it never publishes

**Owner:** `scripts/release/config.ts`, `validate.ts`

`--rehearsal` waives only the git checks (branch, clean tree, pushed), takes
`--version` and scratch credentials through the existing
`LOCALBOX_SIGNING_DIR` and `LOCALBOX_RELEASE_PUBLIC_KEY`, and turns `publish`
into a dry run; a real run refuses `--version` and
`LOCALBOX_RELEASE_PUBLIC_KEY`. `ALLOW_UNSIGNED`, `APPLE_SIGNING_IDENTITY`,
`RELEASE_PRIVATE_KEY`, `RELEASE_KEY_ID` and `VERSION` are gone: every build is
signed from one signing folder, scratch or real. Probe 42 drives the build
stage this way.

- **Verdict:** sound. **Confidence:** high.

### R4. Each stage judges the groups it depends on, from facts gathered apart

**Owner:** `scripts/release/validate.ts`

`gatherFacts` only reads (a `git fetch` aside); `judge` is pure, so every
refusal sentence is tested against fake facts. `validate` judges everything,
`build` the tree and the local inputs (it binds the release to a commit),
`publish` git and GitHub, where an existing draft of the version is reused
rather than refused. The free-disk floor is twice the image's allocated size
plus 4 GiB.

- **Verdict:** sound. **Confidence:** high.

### R5. The build's receipt binds smoke and publish to one build

**Owner:** `scripts/release/build.ts`

`build` writes `dist/release.build.json` beside the folder (inside it, it
would become an asset): version, commit, rehearsal or not, and the public
key's digest. `smoke` and `publish` refuse a folder built for another version
or key, and `publish` refuses unless `HEAD` is the built commit.

- **Verdict:** sound. **Confidence:** high.

### R6. TypeScript stages, with the shell script folded in

**Owner:** `scripts/release/`

The stages are TypeScript run by `tsx`, like the proof harness, so they call
the owners directly (`release.ts` and `appcast.ts` for manifest and feed,
`sign.mjs` for signing, `framework.mjs` for the Sparkle receipt,
`installation.ts` and `packaged-app.ts` for the smoke) instead of shelling
out to heredocs. `sign.mjs` and `framework.mjs` gained small `.d.mts` type
files. The version bump is a documented `npm version X.Y.Z
--no-git-tag-version`, not a helper.

- **Verdict:** sound. **Confidence:** medium–high.
