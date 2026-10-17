# Positioning

**Give your agents all your computers.**

Localbox lets every agent you run, on your laptop, in the cloud or on a schedule,
work on every Mac you own. Sign a Mac in with your email and it joins; any agent
you've signed in can open a sandbox on any of those Macs, from anywhere, with no
VPN, port forwarding or SSH keys. Each sandbox is a whole Linux computer with a
shell, files, a browser and a desktop, and it stays exactly as the agent left it
until someone deletes it.

It's not SSH. SSH hands an agent your whole computer: your files, your keys, your
logged-in sessions. Localbox hands it a sandbox, where it works with
permission prompts off; your own files are out of reach unless you share a
folder, and every access to a shared folder is logged.

**Reach** is the headline: your agents get all your computers. **Sandbox** is the
product word and the reason it's safe to say yes. Say "virtual machine" only
where isolation is the question, and then name what it is: a full Linux VM on
Apple's own Virtualization framework. **Durable** is a benefit, not the pitch:
cloud sandboxes and containers are disposable by design, and a Localbox sandbox
keeps its installs, files and browser state until it's deleted. Idle sandboxes
go to sleep instead, and every process, down to a running dev server, resumes on
the next request. Disposable is an option (delete after an idle period), not the
default.

Every sandbox, machine and account gets a generated, renameable name like
`quiet-otter` or `brave-walrus-482`. Names are friendly handles; they never grant
access.

The product is a tool *for* agents, not an agent. It has no built-in AI and makes
no decisions about the work; the user's agent (Claude Code, Codex, any harness)
drives it through one CLI, with MCP as an optional adapter.

Who it's for: individual developers who run coding agents every day and want
those agents working on their own hardware, not one laptop and not a rented
cloud. It starts with the Mac you're on, and every Mac you add joins. It's
personal: one person's machines, one identity. Teams come later, if the personal
product earns them.

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

## 1. Your machines are the fleet

An agent today works on the one machine it was started on. Plenty of developers
own more than that: a desktop with the RAM for the full build, a Mac mini on the
shelf, last year's laptop. Localbox puts all of them in reach of every agent,
without renting compute in someone else's cloud.

- Every Mac signed in to your account joins your fleet, wherever it is.
- Sandboxes stay on the machine the agent is running on unless it asks otherwise:
  name a machine, or ask for automatic placement across all of them. Nothing lands
  on another computer by surprise.
- No per-minute bill and no session limit. The hardware is already paid for.
- Code and data stay on machines you own.

## 2. Cloud agents, your computers

Background agents (Codex cloud, Claude Code on the web, scheduled agents) run in
someone else's cloud, far from your machines. With Localbox they reach your
computers from there and do the work on your hardware.

- The Mac connects out to the hosted relay; there is no port forwarding, VPN,
  Tailscale or SSH key.
- The agent signs in on a Localbox page with your email and a code; its token
  covers your account and is revocable at any time.
- Requests that might have half-applied are reported as uncertain, never retried
  silently.

## 3. A sandbox, not your whole computer

Reaching every computer is only worth it if handing that reach to an agent is
safe. SSH gives the agent your whole computer; a sandbox gives it one of its own.
And the fastest agents run with permission prompts off, which is exactly what
people are afraid to do on their own laptop.

- Run Claude Code or Codex with full autonomy inside a sandbox. The sandbox is the
  boundary, so there is nothing inside it worth prompting about.
- Try untrusted repos, install scripts and dependencies somewhere that isn't your
  machine.
- The worst case is deleting the sandbox.

## 4. Share a folder, see every access

A sandbox sees nothing on your Mac by default. When the agent needs your project,
you share exactly that folder, read-only or read-write, and Localbox records every
read and write the sandbox makes through it.

- Share a project folder with a sandbox, nothing else.
- Read-only by default; read-write when you say so.
- An audit log of every file the sandbox opened, read or wrote through the share.

## 5. One sandbox per agent, many agents at once

Parallel agents step on each other in one checkout and one set of ports.

- Each task or branch gets its own sandbox, with its own dev server, database and
  browser.
- Fan out several attempts at a problem, keep the winner, delete the rest.

## 6. A computer that's still set up next week

The durable default, in its purest form: a configured environment, a logged-in
browser, an overnight build.

- Sandboxes persist across sessions, sleep and reconnects.
- Long jobs run as long as they need.
- A real desktop and browser for computer-use tasks.

## 7. Sandboxes without the container tax

Docker on a Mac means a background VM that claims gigabytes of RAM and a fixed
disk image the moment it starts, plus containers and volumes that pile up until
someone prunes them. An agent shouldn't have to manage any of that, and neither
should you.

- The agent creates a sandbox for a task, uses it, and deletes it, one command
  each.
- New sandboxes start in seconds and share storage until they diverge.
- Each sandbox is sized to its machine by default and can be resized; the agent
  is told exactly what it got.
- Idle sandboxes sleep and wake on the next request with every process intact. A
  sandbox can opt into deleting itself after an idle period.
- When a machine runs out of room, Localbox sleeps the least recently used
  sandboxes to fit the new one, and tells the agent which.
- A sandbox is a whole computer, not a process: it can run Docker inside itself, a
  browser, a desktop app or a system service.

The honest resource claim: a running sandbox reserves memory like any VM. What
changes is the lifecycle: start on demand, sleep when idle, delete in one command.
Never say "uses no RAM".

## 8. Built for agents to drive

The CLI's customer is an agent, not a person. Every command does what it was asked
when the result can be undone, and says exactly what it did: the size and machine
it chose, the sandboxes it slept to make room, the restart a resize needed, the
output it trimmed. The agent never has to guess or ask a follow-up question.

## What this means for messaging

- Lead with what it enables: your agents can use every computer you own, from
  wherever they run. The sandbox is why that's safe to say yes to, so it comes
  right after the reach, never instead of it. Never lead with virtualization.
- The alternative to name is SSH: the same reach, but the agent gets your
  whole computer. Say "your whole computer", not "your account", which reads as
  a login. Local containers and the cloud sandbox bill are supporting
  comparisons, not the opening argument. Don't name other sandbox tools.
- Say "sandbox" for the product, "durable" for the default, "computer" for what's
  inside one. Name the VM only to answer how sandboxes are isolated.
- Don't leave out the single-Mac user: it starts with the Mac you're on, and
  every Mac you add joins.
- Keep "your files stay yours" visible: nothing shared unless you choose, and
  every shared access logged. It's what makes full autonomy feel safe.
- Free and personal. Don't mention plans, seats or teams.
- Sign-in is "your email and a code". Never mention passwords, keys or pairing.
- Sleep is the answer to "doesn't a VM eat my RAM?": idle sandboxes sleep,
  give their memory back and resume exactly where they were. The installer
  checks the Mac is set up for it; don't promise it beyond that.
- Snapshots and rollback stay out of the message until they exist.
- Marketing (the README, the site and the pitch in `llms.txt`) describes the
  launch product and never its build status. Instructions an agent follows (the
  install steps and the skill) must only describe what the shipped CLI does; an
  agent that runs a planned command fails.
- `llms.txt` sells and installs. How to use Localbox lives in the skill.
