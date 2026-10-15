---
name: localbox
description: Give yourself durable Linux sandboxes on the user's own Macs through the localbox CLI — a shell, files, a browser and a desktop that stay exactly as you left them, sleep when idle and wake on use. Use when the user wants work done in a sandbox rather than on their machine (installs, test suites, untrusted code, permissions-off runs, long builds, a dev server kept running), wants a sandbox on another of their Macs, or asks to install, sign in, set up MCP, or check, update or remove the Localbox skill and CLI.
---

# Localbox

You drive Localbox through the `localbox` CLI. Every command acts, then reports
exactly what it did. Read the report; never guess what happened.

## First use

Run `command -v localbox`, then try `~/.local/bin/localbox` (a harness launched
from the Dock may not read the shell profile that puts it on PATH). If neither
exists and the user asked for setup, follow [installation](references/installation.md).
Never build from source, run `npx skills add`, or copy this skill yourself.

Creating sandboxes needs a signed-in Mac:

```sh
localbox login --email you@example.com          # sends a 6-digit code
localbox login --email you@example.com --code NNNNNN   # ask the user for the code
```

## Sandboxes

- `localbox sandbox create` makes one and reports its generated name (like
  `quiet-otter`), machine, size and why. Override with `--name`, `--cpus`,
  `--memory 4G`, `--sleep-after 10m` (default 30 min idle), `--delete-after 2h`
  (only when it should be disposable).
- Placement: by default it lands on this Mac. `--machine NAME` picks one of the
  user's machines (`localbox machines list`); `--placement auto` takes the online
  machine with the most room, `--placement remote` the same but never this Mac.
- `localbox sandbox list`, `sandbox status`, `sandbox rename`, `sandbox resize`,
  `sandbox sleep`, `sandbox start`, `sandbox stop`, `sandbox logs`.
- `localbox sandbox delete NAME --confirm NAME` only with the user's explicit
  go-ahead; it destroys the disk.

Every per-sandbox command takes `--sandbox NAME` (or the name as its first word
for `sandbox …` commands). Leave it out only when the account has exactly one
sandbox. A sandbox on another Mac needs no `--machine`; the name is enough.

## Running things

```sh
localbox shell exec --sandbox NAME -- npm test
localbox shell exec --sandbox NAME --background -- npm run dev   # returns job_id
localbox job wait JOB_ID --timeout-ms 120000 --sandbox NAME
localbox job output JOB_ID --offset 0 --sandbox NAME
localbox fs read /etc/os-release --sandbox NAME
localbox fs write /work/notes.txt "hello" --sandbox NAME
```

Results are capped at 900 KiB. A trimmed result says so (`truncated` with
`original_bytes` and `returned_bytes`); keep reading with `--offset` from
`next_offset` until `eof` (`fs read`, `job output`). Use `--background` for
anything that may run longer than two minutes, then `job status`, `job wait`,
`job output` or `job cancel`. `browser …` and `desktop …` commands drive the
sandbox's browser and its 1440×900 desktop.

## Reading results

- `--json` prints the envelope: `ok`, then `result` or `error` (`code`,
  `message`, `retryable`, `details`). Text prints the same facts. Exit 0 is
  success, 1 an error, 2 not signed in.
- A change reports `requested`, `produced` and `actions`. Each action has a
  `kind` and a `detail` saying why: `created`, `renamed`, `deleted`, `woke`,
  `cold_booted` (its processes did not survive; the detail says why), `slept`,
  `made_room` (a full Mac slept its least recently used idle sandbox for you),
  `restarted`, `truncated`. Tell the user about anything that changed their world,
  such as a restarted dev server.
- A sandbox idle for its sleep time (no request, no running job) sleeps. The next
  command wakes it first and reports `woke` or `cold_booted`. A sandbox running a
  job never sleeps to make room.
- Errors name the way out: `sandbox_ambiguous` and `sandbox_not_found` list the
  names, `machine_full` lists what holds the memory, `machine_offline` is
  retryable. Never blindly repeat a mutation after `operation_uncertain`: read
  status first, or repeat it with the same `--mutation-id`.

## MCP

The CLI needs no MCP. When a client wants tool discovery, `localbox mcp install`
prints the server config; tools are the same operations with a `sandbox`
argument (or `machine` for machine-level tools), and the client signs in with the
user's email code.

## Keeping Localbox current

Releases update themselves. `localbox update check` and `localbox update install`
do it on demand. With agent setup on (the default), every install and every
daemon start makes this skill and the `localbox` link match the installed
release. For `skill status`, maintenance on or off, and project-scope or
comparison installs, read [skill lifecycle](references/skill-lifecycle.md). To
find any operation or its schema, read [capabilities](references/capabilities.md).

If the current project has its own copy of this skill (`.claude/skills/localbox`,
`.agents/skills/localbox` or `.codex/skills/localbox` under the project root), it
may be stale and shadow the maintained global one: tell the user and suggest
deleting it. Never delete it yourself.
