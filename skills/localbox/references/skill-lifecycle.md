# Skill lifecycle

The installed release maintains this skill and the `localbox` command itself.
Prefer the operations below over editing skill folders by hand. Use the manual
steps only for a project-scope install, a comparison, or when an operation
reports a problem.

## Updates

Releases update themselves: a background updater installs each new signed
release after verifying it, and nothing is replaced if verification fails.
`localbox update check` and `localbox update install` do the same on demand.
Sandbox disks survive every update.

## Agent setup

One setting, **agent setup**, is on by default. While it is on, Localbox owns
the global `localbox` skill (in `~/.agents/skills/localbox`, linked into every
agent harness the pinned `skills@1.7.0` installer knows) and the
`~/.local/bin/localbox` link. It makes both match the installed release at the
end of every install and at every start of the host daemon, which includes the
relaunch after each update. There is no other timer.

```sh
localbox agents setup status   # enabled, skill state, source_revision, cli_link
localbox agents setup off      # Localbox stops touching the skill and the link
localbox agents setup on       # takes effect at the next daemon start or skill install
```

Turn it off before customising the global skill; while it is on, a customised
copy is replaced at the next daemon start. A copy Localbox did not write is
backed up before it is replaced, and the result names the backup folder.
Inspecting never changes anything.

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
  setup on, the result says the next daemon start installs it again; turn agent
  setup off first to keep it removed.
- `localbox cli status`: whether `~/.local/bin/localbox` points at the active
  release (`linked`, `missing`, `elsewhere`, or `not_a_link` for a file Localbox
  did not write and leaves alone).

## Project-scope or comparison install

Only when the user asks for this skill in one project, or wants to compare a
local copy with the release's. The source is the copy bundled in the installed
release, so it always matches the CLI. Use the release's own Node and pinned
installer; nothing needs the host's Node:

```sh
lb="$HOME/Library/Application Support/Localbox/releases/active/localbox-cli"
cd /path/to/project
test ! -e .agents/skills/localbox && test ! -L .agents/skills/localbox || exit 1
"$lb/node" "$lb/skills-installer/bin/cli.mjs" add "$lb/skill" --skill localbox --agent codex claude-code --yes
diff -ru "$lb/skill" .agents/skills/localbox
```

When scope is unclear and the directory looks like a project, ask "this project
or the whole computer?" before writing; the whole computer is already covered by
agent setup. A project copy is never maintained: it shadows the global skill and
goes stale with the next release, so tell the user it needs this step again after
updates.

To compare without installing, run only `diff -ru "$lb/skill" <installed folder>`
and report the differences. Exit 1 means they differ; above 1 means the
comparison failed.
