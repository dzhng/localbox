# Positioning

**Stop renting sandboxes. You already own them.**

Localbox turns every Mac you own into sandboxes for your agents: Linux or macOS,
set up your way, and still there next week. Free.

Coding agents need somewhere to work that isn't your laptop, and the usual answer
is a cloud sandbox: rented by the minute, thrown away after the session, set up
from scratch every time, and Linux only. Meanwhile the Macs you already paid for
sit idle: the desktop with the RAM for the full build, the Mac mini on the shelf,
last year's laptop. Localbox makes those Macs the sandboxes.

Sign a Mac in with your email and it joins; any agent you've signed in, on your
laptop, in the cloud or on a schedule, can open a sandbox on any of those Macs,
from anywhere, with no VPN, port forwarding or SSH keys. Each sandbox is a whole
computer, Linux or macOS, with a shell, files, a browser and a desktop, and it
stays exactly as the agent left it until someone deletes it. Set one up the way
you like it, save it as an image, and every new sandbox starts from that.

It's not SSH. SSH hands an agent your whole computer: your files, your keys, your
logged-in sessions. Localbox hands it a sandbox, where it works with permission
prompts off; your own files are out of reach unless you share a folder, and every
access to a shared folder is logged.

**Sandbox** is the product word and the reason it's safe to say yes. Say "virtual
machine" only where isolation is the question, and then name what it is: a full
VM on Apple's own Virtualization framework. **Durable** is part of the subhead
("still there next week"): cloud sandboxes and containers are disposable by
design, and a Localbox sandbox keeps its installs, files and browser state until
it's deleted. Idle sandboxes go to sleep instead, and every process, down to a
running dev server, resumes on the next request. Disposable is an option (delete
after an idle period), not the default.

Every sandbox, machine, image and account gets a generated, renameable name like
`quiet-otter` or `brave-walrus-482`; the one fixed name is the built-in `linux`
image, and `macos` is reserved for the account's macOS base. Names are friendly
handles; they never grant access.

The product is a tool *for* agents, not an agent. It has no built-in AI and makes
no decisions about the work; the user's agent (Claude Code, Codex, any harness)
drives it through one CLI, with MCP as an optional adapter.

Who it's for: individual developers who run coding agents every day and want
those agents working on their own hardware, not one laptop and not a rented
cloud. It starts with the Mac you're on, and every Mac you add joins. It's
personal: one person's machines, one identity, the person's own work. Teams come
later, if the personal product earns them. Products that want people's Macs as
their sandbox backend are not the audience.

It's free. The account exists so the identity is stable; it is not a paywall.

## Identity

An account is one person, identified by a verified email address. Signing in is
an email code, never a password: `localbox login` asks for the email, Localbox
emails a 6-digit code, and the agent pastes it back. The same email from a new
MacBook in another country joins the same account; nothing at home has to do
anything, and losing every machine just means logging in again.

Every machine the person signs in, and every sandbox and image on those machines,
belongs to that account. A machine keeps one credential that lasts until it logs
out or is removed. Cloud agents connecting over MCP sign in with the same email and
code, and the page says plainly that the agent gets full access to the account.
The email is the stable identity that premium features can attach to later.

## 1. Stop renting sandboxes

A cloud sandbox is someone else's computer by the minute. It forgets everything
when the session ends, so every session starts by reinstalling the world, and it
runs Linux only. The Macs you own are already paid for.

- No per-minute bill and no session limit. The hardware is already yours.
- A sandbox keeps its state until you delete it, not until the session times out.
- Code and data stay on machines you own.
- Linux or macOS, set up your way and saved as your own images.

## 2. Your machines are the fleet

An agent today works on the one machine it was started on. Localbox puts every
Mac you own in reach of every agent.

- Every Mac signed in to your account joins your fleet, wherever it is.
- Sandboxes stay on the machine the agent is running on unless it asks otherwise:
  name a machine, or ask for automatic placement across all of them. Nothing lands
  on another computer by surprise.
- Cloud agents (Codex cloud, Claude Code on the web, scheduled agents) reach your
  Macs through a relay each Mac connects out to: no port forwarding, VPN,
  Tailscale or SSH key. Their token covers your account and is revocable at any
  time.
- Requests that might have half-applied are reported as uncertain, never retried
  silently.

## 3. Set up your way: images

Every developer's environment is different, and an agent shouldn't reinstall it
for each task. Set a sandbox up once, save it as an image, and start new
sandboxes from it on any of your Macs.

- Any sandbox can be saved as an image while it runs; it pauses for about a
  second. Sandboxes made from it get their own identity.
- Make an image your default and every new sandbox starts from it.
- An image moves straight from one of your Macs to another, over your local
  network or a direct connection across the internet, never through anyone's
  cloud storage. A sandbox asked for on a Mac without its image copies it there
  first and says so.

## 4. macOS sandboxes

Some work needs a Mac: building and testing iOS and Mac apps in Xcode, and
using Mac apps through the desktop. A macOS sandbox is a whole Mac of its own,
with every operation a Linux sandbox has, desktop and browser included.

- The macOS base is built on your own Mac, with no human step. macOS comes from
  Apple's restore image and Chrome from Google; Localbox adds only its agent,
  forwarder and desktop helper, shipped in the signed app.
- Xcode isn't included (it needs an Apple ID). The agent installs it once in a
  macOS sandbox, with your Apple ID or an installer you share, and saves that as
  an image.
- Apple's licence allows macOS VMs for your own development, testing and personal
  use, at most two running per Mac, so macOS sandboxes are for the person who
  owns the Mac.

## 5. A sandbox, not your whole computer

Reaching every computer is only worth it if handing that reach to an agent is
safe. SSH gives the agent your whole computer; a sandbox gives it one of its own.
And the fastest agents run with permission prompts off, which is exactly what
people are afraid to do on their own laptop.

- Run Claude Code or Codex with full autonomy inside a sandbox. The sandbox is the
  boundary, so there is nothing inside it worth prompting about.
- Try untrusted repos, install scripts and dependencies somewhere that isn't your
  machine.
- The worst case is deleting the sandbox.

## 6. Share a folder, see every access

A sandbox sees nothing on your Mac by default. When the agent needs your project,
you share exactly that folder, read-only or read-write, and Localbox records every
read and write the sandbox makes through it.

- Share a project folder with a sandbox, nothing else.
- Read-only by default; read-write when you say so.
- An audit log of every file the sandbox opened, read or wrote through the share.

## 7. One sandbox per agent, many agents at once

Parallel agents step on each other in one checkout and one set of ports.

- Each task or branch gets its own sandbox, with its own dev server, database and
  browser.
- Fan out several attempts at a problem, keep the winner, delete the rest.

## 8. Still there next week

The durable default, in its purest form: a configured environment, a logged-in
browser, an overnight build.

- Sandboxes persist across sessions, sleep and reconnects.
- Long jobs run as long as they need.
- A real desktop and browser for computer-use tasks.

## 9. Sandboxes without the container tax

Docker on a Mac means a background VM that claims gigabytes of RAM and a fixed
disk image the moment it starts, plus containers and volumes that pile up until
someone prunes them. An agent shouldn't have to manage any of that, and neither
should you.

- The agent creates a sandbox for a task, uses it, and deletes it, one command
  each.
- New sandboxes start in seconds and share storage with their image until they
  diverge.
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

## 10. Built for agents to drive

The CLI's customer is an agent, not a person. Every command does what it was asked
when the result can be undone, and says exactly what it did: the size and machine
it chose, the sandboxes it slept to make room, the image it started from and the
copy it made to get it there, the restart a resize needed, the output it trimmed.
The agent never has to guess or ask a follow-up question.

## What this means for messaging

- Open with ownership: stop renting sandboxes, you already own the computers.
  The cloud sandbox (by the minute, thrown away, set up from scratch) is the
  first comparison and the opening argument. Reach across all your Macs and the
  SSH comparison come right after it, never instead of it. Never lead with
  virtualization.
- The SSH comparison stays: the same reach, but the agent gets your whole
  computer. Say "your whole computer", not "your account", which reads as a
  login. Local containers are a supporting comparison. Don't name other sandbox
  tools or cloud sandbox vendors.
- A sandbox is "a whole computer, Linux or macOS". Say "sandbox" for the product,
  "durable" for the default, "computer" for what's inside one, "image" for a
  saved setup. Name the VM only to answer how sandboxes are isolated.
- macOS sandboxes are for Xcode work and Mac apps through the desktop, on your own
  Macs. Never imply offering them to other people, as a service or otherwise
  (Apple's licence).
- "Any image" means any setup saved from a sandbox, Linux or macOS. Don't
  promise Dockerfiles, arbitrary Docker images or ISOs.
- Don't leave out the single-Mac user: it starts with the Mac you're on, and
  every Mac you add joins.
- Keep "your files stay yours" visible: nothing shared unless you choose, and
  every shared access logged. It's what makes full autonomy feel safe.
- Free and personal, for individual developers. Don't mention plans, seats, teams,
  or building products on top of other people's Macs.
- Sign-in is "your email and a 6-digit code emailed to you". Never mention
  passwords, keys or pairing.
- Sleep is the answer to "doesn't a VM eat my RAM?": idle sandboxes sleep,
  give their memory back and resume exactly where they were. Installing
  checks the Mac is set up for it; don't promise it beyond that.
- While a sandbox runs, the Mac doesn't idle-sleep. Never promise more: the
  display still sleeps, and a closed lid still sleeps the Mac.
- Snapshots and rollback stay out of the message until they exist.
- Marketing (the README, the site and the pitch in `llms.txt`) describes the
  launch product and never its build status. Instructions an agent follows (the
  install steps and the skill) must only describe what the shipped CLI does; an
  agent that runs a planned command fails.
- `llms.txt` sells and installs. How to use Localbox lives in the skill.
