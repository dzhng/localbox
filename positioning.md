# Positioning

**Durable sandboxes for your agent, on computers you already own.**

Localbox turns your Mac, or a shelf of Mac minis, into sandboxes your agent
creates, uses and deletes on its own. Each sandbox is a whole Linux computer with
a shell, files, a browser and a desktop. It stays exactly as the agent left it
until someone deletes it. The agent works inside with no permission prompts; your
own files are out of reach unless you share a folder, and every access to a
shared folder is logged.

**Sandbox** is the product word. The VM is the implementation behind it; say "VM"
only in technical docs. **Durable** is the default and the differentiator:
cloud sandboxes and containers are disposable by design, and a Localbox sandbox
keeps its installs, files and browser state until it's deleted. Idle sandboxes
go to sleep instead: memory is saved to disk, RAM comes back, and every process,
down to a running dev server, resumes on the next request. Disposable is an
option (delete after an idle period), not the default.

Every sandbox, machine and account gets a generated, renameable name like
`quiet-otter` or `brave-walrus-482`. Names are friendly handles; they never grant
access.

The product is a tool *for* agents, not an agent. It has no built-in AI and makes
no decisions about the work; the user's agent (Claude Code, Codex, any harness)
drives it through one CLI, with MCP as an optional adapter.

Who it's for: individual developers who run coding agents every day, own at least
one Mac, and are either fighting local containers or paying monthly for cloud
sandboxes. It's personal: one person's machines, one identity. Teams come later,
if the personal product earns them.

It's free. The account exists so the identity is stable; it is not a paywall.

## Identity

An account is one person, identified by a verified email address. Signing in is
an email code, never a password: `localbox login` asks for the email, Localbox
emails a 6-digit code, and the agent pastes it back. The same email from a new
MacBook in another country joins the same account; nothing at home has to do
anything, and losing every machine just means logging in again.

Every machine the person signs in, and every sandbox on those machines, belongs to
that account. A machine keeps one credential that lasts until it logs out or is
removed. Cloud agents connecting over MCP sign in with the same email and code,
and the page says plainly that the agent gets full access to the account. The
email is the stable identity that premium features can attach to later.

## 1. Sandboxes without the container tax

Docker on a Mac means a background VM that claims gigabytes of RAM and a fixed
disk image the moment it starts, plus containers and volumes that pile up until
someone prunes them. An agent shouldn't have to manage any of that, and neither
should you.

- The agent creates a sandbox for a task, uses it, and deletes it, one command
  each.
- New sandboxes are copy-on-write clones of a template disk: they start fast and
  share storage until they diverge.
- Each sandbox is sized to its machine by default (half the cores, a quarter of
  the RAM) and can be resized; the agent is told exactly what it got.
- Idle sandboxes sleep after 30 minutes and wake on the next request with every
  process intact. A sandbox can opt into deleting itself after an idle period.
- When a machine runs out of room, Localbox sleeps the least recently used
  sandboxes to fit the new one, and tells the agent which.
- A sandbox is a whole computer, not a process: it can run Docker inside itself, a
  browser, a desktop app or a system service.

The honest resource claim: a running sandbox reserves memory like any VM. What
changes is the lifecycle: start on demand, sleep when idle, delete in one command.
Never say "uses no RAM".

Today: one durable VM per Mac, started and stopped by the agent. Create, delete,
template clones, sizing, sleep and idle deletion are **planned**.

## 2. Your machines are the fleet

Cloud sandboxes and cloud VMs bill every month and by the minute, cap session
length, and put your code on someone else's computer. Plenty of developers
already own idle compute: a Mac mini on the shelf, last year's laptop.

- Every Mac signed in to your account joins your fleet.
- Sandboxes stay on the machine the agent is running on unless it asks otherwise:
  name a machine, or ask for automatic placement across all of them. Nothing lands
  on another computer by surprise.
- No per-minute bill and no session limit. The hardware is already paid for.
- Code and data stay on machines you own.

Today: one Mac per account. Multiple machines and placement across them are
**planned**.

## 3. Cloud agents, your computers

Background agents (Codex cloud, Claude Code on the web, scheduled agents) run in
someone else's cloud and rent compute there. With Localbox they do the work on your
hardware instead.

- The Mac connects out to the hosted relay; there is no port forwarding, VPN or
  Tailscale.
- The agent signs in on a Localbox page with your email and a code; its token
  covers your account and is revocable at any time.
- Requests that might have half-applied are reported as uncertain, never retried
  silently.

Today: the relay and MCP endpoint run at `api.localbox.sh`. Tokens are not yet
tied to a signed-in identity (see Identity); that has to land before launch.

## 4. Let your agent off the leash

The fastest agents run with permission prompts off, and that's exactly what people
are afraid to do on their own laptop.

- Run Claude Code or Codex with full autonomy inside a sandbox. The sandbox is the
  boundary, so there is nothing inside it worth prompting about.
- Try untrusted repos, install scripts and dependencies somewhere that isn't your
  machine.
- The worst case is deleting the sandbox.

Today: the boundary exists. The VM does not share the host's files, processes,
credentials or screen (see the [security model](SECURITY.md)).

## 5. Share a folder, see every access

A sandbox sees nothing on your Mac by default. When the agent needs your project,
you share exactly that folder, read-only or read-write, and Localbox records every
read and write the sandbox makes through it.

- Share a project folder with a sandbox, nothing else.
- Read-only by default; read-write when you say so.
- An audit log of every file the sandbox opened, read or wrote through the share.

Implementation note: Apple's built-in shared directories don't expose per-file
events, so an audited share means Localbox serves the folder itself. That is a
deliberate, reviewed host interface, as the security model requires.

Today: **planned**. No host folders are shared. The placeholder is
[specs/shared-folders](specs/shared-folders/README.md).

## 6. One sandbox per agent, many agents at once

Parallel agents step on each other in one checkout and one set of ports.

- Each task or branch gets its own sandbox, with its own dev server, database and
  browser.
- Fan out several attempts at a problem, keep the winner, delete the rest.

Today: **planned**; depends on use case 1.

## 7. A computer that's still set up next week

The durable default, in its purest form: a configured environment, a logged-in
browser, an overnight build.

- Sandboxes persist across sessions, sleep and reconnects.
- Long jobs run as long as they need.
- A real desktop and browser for computer-use tasks.

Today: built. One durable VM with files, packages, browser and desktop state
preserved.

## 8. Built for agents to drive

The CLI's customer is an agent, not a person. Every command does what it was asked
when the result can be undone, and says exactly what it did: the size and machine
it chose, the sandboxes it slept to make room, the restart a resize needed, the
output it trimmed. The agent never has to guess or ask a follow-up question.

Today: the one-catalog CLI and MCP exist; the act-then-report results ship with
the features above.

## Build plan

The launch scope is specified in [specs/durable-sandboxes](specs/durable-sandboxes/README.md):
a slice ladder for every use case above, built on the decisions in its
[unknowns map](specs/durable-sandboxes/map.md).

## Not yet

Snapshots and rollback (checkpoint a sandbox before a risky step, restore it
after) are deliberately out of the message until there's a design. The
placeholder is [specs/sandbox-snapshots](specs/sandbox-snapshots/README.md).

## What this means for messaging

- Lead with the outcome (your agent gets durable sandboxes; you stop managing
  containers and stop paying for cloud sandboxes), not with virtualization.
- Name the two enemies explicitly: local container pain, and the cloud sandbox
  bill.
- Say "sandbox" for the product, "durable" for the default, "computer" for what's
  inside one. Keep "VM" for technical docs.
- Keep "your files stay yours" visible: nothing shared unless you choose, and
  every shared access logged. It's what makes full autonomy feel safe.
- Free and personal. Don't mention plans, seats or teams.
- Sign-in is "your email and a code". Never mention passwords, keys or pairing.
- Sleep is the answer to "doesn't a VM eat my RAM?": idle sandboxes give their
  memory back and resume exactly where they were.
- Marketing may describe the launch product before it ships, and the README and
  site do, and so does the pitch in `llms.txt`. Instructions an agent follows (the
  install steps and the skill) must only describe what the shipped CLI does; an
  agent that runs a planned command fails.
- `llms.txt` sells and installs. How to use Localbox lives in the skill.
