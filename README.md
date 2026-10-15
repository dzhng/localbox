<p align="center">
  <img src=".github/readme/header.png" alt="Localbox — a computer your agent can use" width="100%">
</p>

<p align="center">
  <a href="https://github.com/dzhng/localbox/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/dzhng/localbox?label=release"></a>
  <img alt="macOS 13+ on Apple Silicon" src="https://img.shields.io/badge/macOS-13%2B%20%C2%B7%20Apple%20Silicon-black">
  <img alt="Works with Claude Code, Codex and MCP agents" src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20MCP-blue">
  <img alt="Runs on your Mac" src="https://img.shields.io/badge/runs%20on-your%20Mac-green">
</p>

---

**Localbox gives your AI agent a computer of its own.**

Agents are good at real work: installing toolchains, running test suites,
clicking through a staging site, leaving a long build running overnight. What
they lack is a place to do it. Your laptop is too precious to hand over, and a
throwaway cloud sandbox forgets everything the moment the session ends.

Localbox is that place. It runs a durable Linux VM on your Mac and hands it to
**Claude Code, Codex, or any agent harness** through one CLI, with an optional
MCP endpoint for clients that want tool discovery. The agent gets a shell, a
filesystem, a browser and a desktop. You keep your Mac.

**Your agent gets a computer. You keep yours.**

## A computer, not a sandbox

Most agent sandboxes are disposable by design: spin up, run a command, throw it
away. That is fine for a one-liner and painful for anything real. Every session
starts by reinstalling the world.

The Localbox VM is the agent's machine. Files, installed packages, browser
profiles and desktop state persist across sessions, sleep, VM stops and
reconnects. Set it up once and it is still set up next week.

**[Get started →](#get-started)** Your agent installs it for you.

## Things you can ask for

> "Install Postgres and Node in the VM and get this repo's tests passing."

> "Open the staging site in the VM's browser and click through checkout."

> "Run this untrusted script somewhere that isn't my laptop and show me what it did."

> "Kick off the full build, then screenshot the desktop when it finishes."

> "Pick up where we left off yesterday. The dev server should still be configured."

> "Connect from my cloud agent and run the integration suite on my Mac."

## How it works

<p align="center">
  <img src=".github/readme/01-still-there-next-week.png" alt="The agent leaves its desk at the end of a session and finds everything exactly where it left it" width="85%">
</p>

1. **Ask your agent to install it.** It downloads one signed release, verifies
   its checksums and signature, installs the CLI and skill, and registers a
   small host daemon. No app to drag into a folder.
2. **Your agent starts the VM** and works in it like any computer: shell
   commands, files, a browser, the desktop.
3. **Come back any time.** The VM keeps its state, so the next session, or the
   next agent, picks up exactly where the last one stopped.

## One catalog, two ways in

<p align="center">
  <img src=".github/readme/02-two-handles-one-door.png" alt="One door with a CLI knob and an MCP handle; the same operations wait behind it" width="85%">
</p>

The CLI is the product. MCP is an adapter over the same operation catalog:
identical operations, schemas, errors and permissions, so a request means the
same thing whether it comes from a shell, Claude Code, Codex or a script.

| | What your agent can use |
| --- | --- |
| **Lifecycle** | Start, stop, pause and reset the VM; status, logs and egress identity |
| **Shell** | Run bounded commands, or start long jobs and wait, poll, cancel or read their output |
| **Files** | List, read, write, create and remove paths inside the VM |
| **Browser** | Open, navigate and close tabs; click, type, send keys and take screenshots |
| **Desktop** | Screenshot, move, click, scroll and type on a 1440×900 virtual display |

`localbox help` is generated from that catalog, and so is the MCP tool list.

## Reachable from anywhere, open to nothing

<p align="center">
  <img src=".github/readme/03-outbound-only.png" alt="The Mac's front door stays padlocked while a string runs out of the chimney to the relay" width="85%">
</p>

On your Mac, the CLI talks to the daemon over an authenticated local socket.
When your agent runs somewhere else, a hosted relay carries its requests to your
Mac over a connection **your Mac opens outward**. No port forwarding, no VPN, no
Tailscale. Remote access uses OAuth, can be revoked at any time, and lost
mutations are reported as uncertain instead of being silently retried.

## Your Mac stays outside

<p align="center">
  <img src=".github/readme/04-host-stays-outside.png" alt="The agent builds freely inside a glass jar while your files sit untouched outside it" width="85%">
</p>

The VM is the security boundary. Inside it, an authorized agent can do anything a
shell can, so there are no per-tool approval prompts to click through. Outside
it, your files, processes, credentials and screen are not shared with the VM.
The [security model](SECURITY.md) spells out the boundary and what the relay can
see.

## Get started

Requires **Apple Silicon and macOS 13 or newer**.

Open Claude Code or Codex and say:

> Install Localbox for me by following https://localbox.sh/llms.txt

Then ask for something that needs a computer.

Localbox is pre-release: the first signed build has not been published yet, so
installs succeed once a [release](https://github.com/dzhng/localbox/releases)
exists. The [agent setup](#agent-setup) below is what your agent follows.

## Agent setup

These steps are written for the agent doing the install, so they are precise.

1. **Install from a signed release.** Resolve one stable tag from
   [GitHub Releases](https://github.com/dzhng/localbox/releases/latest), download
   the release kit with its `release.json` and `SHA256SUMS`, verify them against
   the pinned [release public key](skills/localbox/release-public.pem), and run
   the bundled installer. The [installation procedure](skills/localbox/references/installation.md)
   holds the exact commands. Do not build from source for a user install.
2. **Check the install.** The installer places the CLI at `~/.local/bin/localbox`,
   registers the host daemon and a six-hour updater with launchd, and installs the
   global [Localbox skill](skills/localbox/SKILL.md). It bundles its own Node
   runtime, so it never calls the host's `npx` or `npm`. Then run:

   ```sh
   ~/.local/bin/localbox status
   ~/.local/bin/localbox skill status --json
   ~/.local/bin/localbox help --json
   ```

3. **Use it.** `localbox vm start`, then `localbox shell exec -- <command>`.
   Run `localbox auth login` before remote use. `localbox mcp install --json`
   prints optional MCP configuration; nothing else depends on MCP.

Updates arrive automatically and verify before replacing anything;
`localbox update check` and `localbox update install` do the same on demand.
The [skill lifecycle](skills/localbox/references/skill-lifecycle.md) covers
replacement, rollback and unmanaged skills.

## Contributing

Localbox is an npm workspace monorepo: `apps/*` holds product surfaces (CLI,
macOS host daemon, guest agent, relay, MCP, website) and `packages/*` holds the
shared contract, runtime and protocol owners.

```sh
npm install
npm run build
npm test
```

The [development guide](DEVELOPMENT.md) records the principles behind the public
contracts, plus local control-plane smoke tests, deployment configuration and the
release process. The [security model](SECURITY.md) defines the trust boundaries,
and the [rationale](specs/done/agent-computer/README.md) explains why the system
has this shape. The [website](apps/site/README.md) is the public page at
[localbox.sh](https://localbox.sh), with the same instructions as plain text for
agents. README artwork lives in [.github/readme](.github/readme).
