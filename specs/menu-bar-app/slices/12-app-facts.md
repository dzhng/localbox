# 12 · App facts: the one state shape

Needs 09. (Slice 11's progress file is read when present; this slice does not
wait for it.)

## Contract

One CLI command returns everything the popover and Settings show. Every pixel
in slices 13 and 14 is a function of this shape, and warnings are computed
here and nowhere else.

## Why a new command

Recon showed no existing command yields the popover's facts: `host.watch` is
an internal daemon operation, not in the catalog; `sandbox list` answers from
the account when signed in, not from this Mac; `host.watch` rows carry no
names.

## API seam

**`localbox app status --json [--since N] [--timeout-ms M]`**
(`apps/cli/src/app-facts.ts`), returning `AppFacts`:

```
{ version, build: "release" | "dev",
  account: { email, machine_name } | null,
  daemon: "running" | "starting" | "stopped" | "backing_off",
  connector: { state: "connected" | "connecting" | "signed_out" | "down", detail? },
  capacity: { cpus_free, cpus_total, memory_free_bytes, memory_total_bytes, disk_free_bytes } | null,
  hibernate: "available" | "only_while_unlocked" | "unknown",
  open_at_login: "enabled" | "disabled" | "requires_approval" | "not_found",
  agent_setup: { enabled, command: <cli.status state>, skill: <skill.status state> },
  sandboxes: [{ sandbox_id, name, os, state: "running" | "asleep" | "paused" | "stopped" | "starting" | "copying" | "failed", progress?: { done_bytes, total_bytes } }],
  images: [{ name, state: "building" | "copying" | "downloading" | "failed", phase?, progress?: { done_bytes, total_bytes } }],
  builtin_image: "ready" | "downloading" | "failed" | "missing",
  stopping: null | { reason, pending: [name] },
  update: null,                         // slice 15 fills this
  warnings: [{ code, message, fix? }],
  watch_version }
```

- It composes: the app socket's `app.info` and `login_item.get`; the daemon's
  local `host.watch` (long-polled with `--since`, capped at 25 s), local
  `sandbox.list` for names, `image.list` and the latest operation per image for
  progress; `relay.status`; `checkHost()`; stored credentials;
  `agents.setup.status`, `cli.status`, `skill.status`;
  `<root>/builtin-image.json`. `images` lists only work in progress or failed
  on this Mac, not ready images.
- With the daemon down it still answers from the app socket and credentials,
  with `capacity: null` and empty lists.
- **Warning codes**, each with a one-sentence `message` and, where there is
  one, a `fix`: `signed_out`, `connector_down`, `daemon_down`,
  `hibernate_blocked` (fix: the two System Settings changes `host check`
  already names), `builtin_image_missing`, `builtin_image_failed`,
  `login_item_needs_approval`, `not_in_applications`,
  `command_not_installed`. Order in the array is severity order.

**Swift side** (`LocalboxAppCore`): `AppFacts` as `Codable`; `FactsSource`,
which runs `BundledCLI` in a loop (`--since <last watch_version>`), publishes
each new value, and cancels the running child when the popover closes and
Settings is not open. With nothing open it refreshes every 60 s so the status
item's warning badge stays true.

## What the human can run

`localbox app status --json | jq .warnings`, then sign out, stop the connector
child, or lock hibernation and see the matching warning appear.

## Verification

- `node:test` with a scripted transport and a fake app socket: every warning
  code from its cause; daemon down; signed out; a copying sandbox with
  progress; an image building; `--since` returning early on a change and at
  the timeout otherwise.
- Swift: `AppFacts` decodes every fixture the Node tests emit (the fixtures are
  shared JSON files under `apps/macos/App/tests/fixtures/facts/`, written by
  the Node test and read by both sides, so the two never drift).
- Probe 41 at tier `a` gains: a sandbox put to sleep shows `asleep` within one
  long poll.

## Delegated to the implementer

Field naming inside the shape above (keep snake_case); how `FactsSource`
debounces; the exact warning sentences (plain, one sentence, no jargon).

## Must stay green

The catalog and its snapshots (this is a local command, not a catalog
operation); slice 09's `app status` consumers.

## Feedback that would change this slice

A request to show sandboxes on other Macs in the popover: the shape would gain
an account-wide list; today it is this Mac only (brief, decision 3).
