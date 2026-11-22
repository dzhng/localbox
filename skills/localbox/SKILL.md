---
name: localbox
description: Give yourself durable Linux or macOS sandboxes on the user's own Macs through the localbox CLI — a shell, files, a browser and a desktop that stay exactly as you left them, sleep when idle and wake on use, and start from images saved from other sandboxes. Use when the user wants work done in a sandbox rather than on their machine (installs, test suites, untrusted code, permissions-off runs, long builds, a dev server kept running, Xcode or a Mac app), wants a sandbox on another of their Macs, wants to save, reuse or copy a sandbox setup as an image, or asks to install, sign in, set up MCP, or check, update or remove the Localbox skill and CLI.
---

# Localbox

You drive Localbox through the `localbox` CLI. Every command acts, then reports
exactly what it did. Read the report; never guess what happened.

## First use

Run `command -v localbox`, then try `~/.local/bin/localbox` (a harness launched
from the Dock may not read the shell profile that puts it on PATH). If neither
exists and the user asked for setup, follow [installation](references/installation.md).
Never build from source, run `npx skills add`, or copy this skill yourself.

Localbox is a menu bar app, `Localbox.app`, with this CLI inside it. The app
must be running for anything on this Mac to work, and the CLI starts it by
itself, quietly, whenever it is not; never open it yourself. Quitting it takes
this Mac offline until it opens again. `localbox app status` shows what the
app shows: version, daemon and connection, sandboxes, and any warning with its
fix.

Creating sandboxes needs a signed-in Mac:

```sh
localbox login --email you@example.com          # sends a 6-digit code
localbox login --email you@example.com --code NNNNNN   # ask the user for the code
```

With `--json` the steps answer `{"state": "code_sent", ...}` and
`{"state": "signed_in", ...}`; a refusal (a wrong code, a Mac already signed in)
is the usual error envelope (`invalid_input`, `conflict`).

## Sandboxes

- `localbox sandbox create` makes one and reports its generated name (like
  `quiet-otter`), machine, size, image and why. It starts from the account's
  default image (initially the built-in `linux`); `--image NAME` picks another,
  and `--image macos` the account's macOS base ([images](references/images.md)).
  Override with `--name`, `--cpus`,
  `--memory 4G`, `--sleep-after 10m` (default 5 min idle), `--delete-after 2h`
  (only when it should be disposable).
- Placement: by default it lands on this Mac. `--machine NAME` picks one of the
  user's machines (`localbox machine list`); `--placement auto` takes the online
  machine with the most room, `--placement remote` the same but never this Mac.
- `localbox sandbox list` and `localbox sandbox status NAME` show what exists;
  `localbox help` lists the other `sandbox` commands (rename, resize, sleep and
  more), and `localbox help sandbox.resize` shows one
  ([capabilities](references/capabilities.md)).
- `localbox sandbox delete NAME --confirm NAME` only with the user's explicit
  go-ahead; it destroys the disk.

Every per-sandbox command takes `--sandbox NAME` (or the name as its first word
for `sandbox …` commands). Leave it out only when the account has exactly one
sandbox. A sandbox on another Mac needs no `--machine`; the name is enough.
`--machine NAME` names the machine any command is for: where `sandbox create`
puts the sandbox, or which Mac `relay status`, `skill …` and `agents setup …`
act on.

## Images

An image is a sandbox's disk saved under a name; new sandboxes start from it with
their own identity. Read [images](references/images.md) before saving, copying,
deleting or building one, and for macOS sandboxes and getting Xcode into one.

```sh
localbox image create --from NAME --name IMAGE   # save a sandbox (it pauses about a second)
localbox image list                              # OS, size, source, the Macs holding each, the default
localbox image default IMAGE                     # what sandbox create uses with no --image
localbox image wait IMAGE                        # follow a build or copy; call again until ready or failed
```

A sandbox created on a Mac without its image answers at once in state `copying`;
until `localbox image wait IMAGE` reports it created, `sandbox status` shows the
copy's progress and every other command but `sandbox delete` returns
`sandbox_not_ready` (retryable) with it. Deleting it stops the wait, and the copy
too when no other sandbox waits on it.

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
sandbox's browser and its 1440×900 desktop, on Linux and macOS alike. Shell
commands run as root in both; a macOS sandbox has macOS's own tools (`zsh`,
`sw_vers`, no `apt`).

## Reading results

- `--json` prints the envelope: `ok`, then `result` or `error` (`code`,
  `message`, `retryable`, `details`). Text prints the same facts. Exit 0 is
  success, 1 an error, 2 not signed in.
- A change reports `requested`, `produced` and `actions`. Each action has a
  `kind` and a `detail` saying why: `created`, `renamed`, `deleted`, `woke`,
  `cold_booted` (its processes did not survive; the detail says why), `slept`,
  `made_room` (a full Mac slept its least recently used idle sandbox for you),
  `restarted`, `truncated`, `waiting` (a create waiting for its image to copy). Tell the user about anything that changed their world,
  such as a restarted dev server.
- A sandbox idle for its sleep time (no request, no running job) sleeps. The next
  command wakes it first and reports `woke` or `cold_booted`. A sandbox running a
  job never sleeps to make room. While any sandbox runs, the Mac does not idle-sleep
  (its display still does, and closing the lid still sleeps it).
- Sleep frees RAM only where the Mac can hibernate; otherwise the `slept`
  detail says the sandbox paused in memory. `localbox host check` says which
  ([why and the settings](references/installation.md#prepare-the-mac-so-sandboxes-can-hibernate)).
- Errors name the way out: `sandbox_ambiguous` and `sandbox_not_found` list the
  names, `machine_full` lists what holds the memory (or the two macOS sandboxes
  already running; a macOS base build running on that Mac also takes one of the
  two), `machine_offline` is retryable, and image errors
  (`image_not_found`, `disk_full`, `copy_unreachable`, `image_incompatible`)
  carry a next step. Never blindly repeat a mutation after `operation_uncertain`: read
  status first, or repeat it with the same `--mutation-id`.

## MCP

The CLI needs no MCP. When a client wants tool discovery, `localbox mcp install`
prints the server config; tools are the same operations, each with optional
`sandbox` and `machine` arguments that name what the call is for (as `--sandbox`
and `--machine` do), and the client signs in with the user's email code.

## Keeping Localbox current

Localbox.app updates itself and keeps this skill and the `localbox` command
matched to itself at every launch. `localbox update status` shows the
updater; `localbox update install` installs a waiting update now. For updates,
`skill status`, agent setup on or off, and project-scope or comparison
installs, read [skill lifecycle](references/skill-lifecycle.md). To remove
Localbox, follow [installation](references/installation.md#removing-localbox).
To find any operation or its schema, read [capabilities](references/capabilities.md).

If the current project has its own copy of this skill (`.claude/skills/localbox`,
`.agents/skills/localbox` or `.codex/skills/localbox` under the project root), it
may be stale and shadow the maintained global one: tell the user and suggest
deleting it. Never delete it yourself.
