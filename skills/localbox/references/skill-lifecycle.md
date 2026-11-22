# Skill lifecycle

Localbox.app maintains this skill and the `localbox` command itself. Prefer the
operations below over editing skill folders by hand. Use the manual steps only
for a project-scope install, a comparison, or when an operation reports a
problem.

## Updates

The app does not update itself yet. To update, install the latest release with
the [installation procedure](installation.md): it replaces the app in place,
keeping the old copy as a backup, and the new app's first launch brings the
skill and the command up to its version. Sandbox disks survive.

## Agent setup

One setting, **agent setup**, is on by default. While it is on, Localbox owns
the global `localbox` skill (in `~/.agents/skills/localbox`, linked into every
agent harness the pinned `skills@1.7.0` installer knows), the
`~/.local/bin/localbox` command and the marked block that puts `~/.local/bin`
on the login shell's PATH. The app makes them match itself every time it
starts its host daemon: at every launch, including the first. There is no
other timer.

```sh
localbox agents setup status   # enabled, skill state, source_revision, command
localbox agents setup off      # Localbox stops touching the skill and the command, and removes its PATH block
localbox agents setup on       # takes effect at the next launch or skill install
```

Turn it off before customising the global skill; while it is on, a customised
copy is replaced at the next launch. A copy Localbox did not write is backed up
before it is replaced, and the result names the backup folder. Inspecting never
changes anything.

## Operations

They are catalog operations, so the CLI (`--machine NAME` for another Mac) and
MCP (the `machine` argument) answer the same thing. Results report what was installed,
replaced (with the backup path) or left alone, and why.

- `localbox skill status`: `state` is `installed`, `updating`, `missing`,
  `unmanaged` (there, but Localbox is not maintaining it: agent setup is off, or
  Localbox did not write it), `disabled` (removed by `skill uninstall`) or
  `needs_attention` (read `error` and `backup_path`). `source_revision` is the
  release that wrote it; `release` is the installed one; `receipt` is the
  ownership record; `paths` and `destinations` show where it lives.
- `localbox skill install` and `localbox skill update` reinstall this release's
  skill now, whatever the setting says.
- `localbox skill uninstall` removes the skill from every harness. With agent
  setup on, the result says the next launch installs it again; turn agent
  setup off first to keep it removed.
- `localbox cli status`: whether `~/.local/bin/localbox` is the app's launcher
  (`installed`, `missing`, `different` for a file Localbox did not write and
  leaves alone, or `not_in_applications` for an app outside `~/Applications` and
  `/Applications`, where the command looks for it), and whether the login shell
  has it on PATH.

## Project-scope or comparison install

Only when the user asks for this skill in one project, or wants to compare a
local copy with the app's. The source is the copy bundled in the installed app,
so it always matches the CLI. Use the app's own Node and pinned installer;
nothing needs the host's Node:

```sh
lb="$HOME/Applications/Localbox.app/Contents/Resources"   # or /Applications/Localbox.app/Contents/Resources
cd /path/to/project
test ! -e .agents/skills/localbox && test ! -L .agents/skills/localbox || exit 1
"$lb/node/bin/node" "$lb/cli/skills-installer/bin/cli.mjs" add "$lb/cli/skill" --skill localbox --agent codex claude-code --yes
diff -ru "$lb/cli/skill" .agents/skills/localbox
```

When scope is unclear and the directory looks like a project, ask "this project
or the whole computer?" before writing; the whole computer is already covered by
agent setup. A project copy is never maintained: it shadows the global skill and
goes stale with the next release, so tell the user it needs this step again after
updates.

To compare without installing, run only `diff -ru "$lb/cli/skill" <installed folder>`
and report the differences. Exit 1 means they differ; above 1 means the
comparison failed.
