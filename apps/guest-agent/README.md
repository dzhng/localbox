# Guest agent

The service inside every sandbox that answers the host's requests. It speaks
the length-prefixed JSON frame protocol of
[`packages/guest-gateway`](../../packages/guest-gateway/src), which owns
dispatch, jobs and activity; this app only wires that gateway to a transport.

## Why it is a persistent socket service

In the image the agent is a long-lived systemd service (`localbox-guest`)
listening on the Unix socket named by `LOCALBOX_AGENT_SOCKET`, and a second
unit (`localbox-vsock.service`) runs socat to forward each connection on vsock
port 1024 to that socket. A host connection can drop at any time: the daemon
restarts, or a sandbox restores from hibernation. Because socat forks per
connection and the agent outlives them, a dropped connection ends only that
connection, never the agent, its job table, its mutation replay or the
processes it started. Do not fold the two units into one: an agent run as
socat's child dies with the connection, and systemd then kills every process it
started.

A third unit (`localbox-control-vsock.service`) forwards vsock port 1025 to
the agent's control socket (`LOCALBOX_CONTROL_SOCKET`): the control lane, which
carries freeze, thaw and agent updates. It is a separate port, not frames on the request
lane, because the request lane serializes requests with no timeout and journals
mutations to disk; a freeze must answer while a request is in flight and must
not write to the filesystem it freezes. Nothing on the control path writes to
disk or logs. A freeze always arms a self-thaw (10 s unless the host asks for
another, at most 30 s), so a host that dies mid-clone never leaves the guest
frozen; dropping the control connection alone does not thaw. Only a Linux guest
that owns its root runs `fsfreeze`; darwin and a fixture guest only `sync`.

## Self-update

The host is the authority on the agent: `npm run build:guest-agent` embeds the
build's version in each binary (`agent-version.json`'s `version`), and the
agent names it, with its OS, in every ready frame. A host shipping another
build pushes its binary over the control lane: a header, then chunks under the
frame limit, written to a temp file beside the running binary. Only when the
last chunk verifies against the announced sha256 is it renamed over the
binary, so the path always holds a complete agent; the agent answers `updated`
and exits, and its supervisor starts the new one. The VM keeps running, and so
does every process the agent started. An update waits while a job runs
(`deferred`): the job table lives in this process and would not survive it.
An agent run from source has no binary of its own and refuses updates. On
darwin a replaced binary loses its screen-capture grant (spike 18), so after
every swap the system role rewrites its TCC rows before answering `updated`.

## darwin: two roles

macOS only lets a process in the logged-in GUI session capture the screen and
post input, so the darwin binary runs twice
([launchd units and `install.sh`](darwin)):

- The **system role**, a root LaunchDaemon, is the agent the host talks to:
  shell, files, jobs, the control lane, forwarded from vsock by
  `localbox-vsock` (the darwin socat).
- The **desktop role** (`--desktop`), a LaunchAgent in the auto-login
  session, answers every `desktop.*` and `browser.*` call, which the system
  role forwards over `/var/run/localbox/desktop.sock`. The system role owns
  that socket (root, mode 0600, an ACL entry for the desktop user only) and
  the desktop role dials in, so nothing else in the session can pose as root.
  It drives the screen through the `localbox-desktop` Swift helper beside the
  agent (ScreenCaptureKit and CGEvent are out of a Bun binary's reach) and
  starts Chrome in the session on the first browser call. TCC holds the agent
  responsible for the helper it spawns, so the agent's rows grant both. An
  update restarts only the system role; the desktop role notices its binary
  was replaced when it redials and exits for launchd to start the new one.

`localbox-agent --grant-tcc` (as root, with the desktop user logged in)
writes the TCC rows; an image build runs it once after `install.sh`. The build
output's `darwin/` holds everything else the build installs (`install.sh`, the
units, the helper and the forwarder), so the host app ships all of it.

Each new connection starts at the channel epoch the last one ended on; the
host's `hello` frame raises it and carries the sandbox's identity (the agent
then sets the hostname, with `scutil` on darwin, and steps the clock after a
restore; a fresh clone also replaces its SSH host keys and, on Linux, its
machine-id). Requests with a
stale epoch are refused.

Without `LOCALBOX_AGENT_SOCKET` the agent serves one connection on standard
input and output. That is how the process-fixture backend and tests run it,
without booting a VM.

## Configuration

[`src/index.ts`](src/index.ts) reads every environment variable it uses, with
its default; the Linux image's unit files in
[`packages/vm-image/Dockerfile.arm64`](../../packages/vm-image/Dockerfile.arm64)
and the darwin plists in [`darwin`](darwin) set the production values.

A local protocol smoke test:

```sh
printf '' | LOCALBOX_ROOT="$PWD" LOCALBOX_READINESS_MARKER="$PWD/.localbox-ready" \
  npx tsx apps/guest-agent/src/index.ts
```
