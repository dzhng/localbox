# 07 · CLI: app-managed layout, launcher, home command

Needs 03 (go, and its tree-or-single-file decision).

## Contract

The CLI knows it lives inside `Localbox.app` from its own realpath. When the
app is not running it starts it quietly and waits. It alone writes the home
command `~/.local/bin/localbox`, the PATH block and the skill.

The old pieces (`updater.ts`, `connector-job.ts`, the installer) still exist
after this slice; slice 10 deletes them.

## API seam

- **`apps/cli/src/layout.ts`**: `layout()` returns
  `{ skill, skillsInstaller, revision, app: string | null, launcher: string | null }`.
  `app` is the bundle path when the file's realpath is
  `<X>.app/Contents/Resources/cli/…`; `launcher` is
  `<app>/Contents/Resources/bin/localbox`. `revision` is read from
  `Resources/cli/version`. The checkout layout keeps working. The
  `releases/active` logic and the `installer` and `cli` fields stay until
  slice 10 removes their last callers.
- **`apps/macos/App/launcher/main.c`** (new; port of Bento's
  `scripts/launcher/main.c`, about 90 lines):
  1. take a shared `flock` on `~/Library/Caches/sh.localbox.mac/launch.lock`
     after checking the file is private, single-link and owned by the user;
  2. if it is held exclusively, print the CLI's JSON failure envelope with code
     `conflict`, message "Localbox is updating; try again in a moment",
     retryable, and exit 75;
  3. pick `$LOCALBOX_APP`, then `~/Applications/Localbox.app`, then
     `/Applications/Localbox.app`;
  4. `execv` `Contents/Resources/cli/localbox`, exporting the lock's fd.
  The inner `cli/localbox` is today's `scripts/cli-launcher.sh`, moved to
  `apps/macos/App/cli-entry.sh`.
- **`apps/cli/src/app-launch.ts`** (new): `ensureApp(layout, paths)`. When the
  local socket is missing or refuses, and `layout.app` is set, and
  `LOCALBOX_MACHINE_ROOT` is unset, run `open -g <layout.app>` (or the launch
  command spike 01 chose,
  `/bin/launchctl asuser $(id -u) /usr/bin/open -g <app>`), retrying the
  launch once after 1 s if it fails (spike 02 saw one failure in about 70,
  right after an exit), and poll the daemon socket every 250 ms for up to
  20 s, then dispatch the original request. A timeout returns the existing
  retryable local-transport error with "Localbox did not start within 20 s;
  open Localbox from Applications" as its message. Called from the one place
  the CLI builds its local transport in `index.ts`.
- **`apps/cli/src/agent-setup.ts`**: `reconcileLink` becomes
  `reconcileCommand`. It writes the launcher's bytes to
  `~/.local/bin/localbox` (temp file, `rename`, mode 0755), only when
  `layout.app` is inside an Applications folder. States (visible through
  `cli.status`): `installed`, `missing`, `different` (another file is there;
  left alone, as a foreign link is today), `not_in_applications`,
  `not_app_managed`. Regenerate `snapshots/`.
- **`apps/cli/src/shell-profile.ts`** (new): a port of
  `scripts/localbox-path.sh` with the same markers
  (`# >>> localbox >>>` … `# <<< localbox <<<`) and the same rule (add only
  when no login file already puts `~/.local/bin` on PATH). `AgentSetup` calls
  it; turning agent setup off removes exactly that block.

## What the human can run

In a scratch `HOME`, with slice 03's assembled bundle copied to
`~/Applications/Localbox.app`: `localbox agents reconcile --reason explicit
--json`, then `~/.local/bin/localbox help`, then `cmp ~/.local/bin/localbox
<bundle>/Contents/Resources/bin/localbox`.

## Verification

- `node:test`: layout (app, checkout); command states including a foreign file
  left alone and an edited artifact reported `different`; shell profile (port
  the cases in Bento's `tests/shell-profile.test.mjs`); `ensureApp` with a fake
  `open` and a fake socket: starts, times out, skipped under
  `LOCALBOX_MACHINE_ROOT`.
- A launcher test (compiled in the test): shared lock proceeds, exclusive lock
  exits 75 with the JSON envelope, lookup order, refusal when no app is found.
- Probe 14 keeps passing on the old path (it is rewritten in slice 10).

## Delegated to the implementer

Where the compiled launcher is built during development (`npm run build` step
or the app package's build); the exact `cli.status` field names beyond the
state values above; poll interval within 100–500 ms.

## Must stay green

`tests/skill-manager.test.ts`, `tests/skill-commands.test.ts`, the contract
snapshot tests, `tests/client.test.ts`, and fixture transport.

## Feedback that would change this slice

The user wanting a refusal instead of auto-launch (brief, decision 6 chose
auto-launch).
