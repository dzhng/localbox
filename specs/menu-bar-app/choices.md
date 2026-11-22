# Choices made while implementing

Decisions a slice left to the implementer. Each says what, why, and how to reverse it.

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
