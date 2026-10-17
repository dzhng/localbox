<p align="center">
  <img src=".github/readme/header.png" alt="Localbox — give your agents all your computers" width="100%">
</p>

<p align="center">
  <a href="https://github.com/dzhng/localbox/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/dzhng/localbox?label=release"></a>
  <img alt="macOS 14+ on Apple Silicon" src="https://img.shields.io/badge/macOS-14%2B%20%C2%B7%20Apple%20Silicon-black">
  <img alt="Works with Claude Code, Codex and MCP agents" src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20MCP-blue">
  <img alt="Free" src="https://img.shields.io/badge/price-free-green">
</p>

---

**Localbox gives your agents all your computers.**

Your agent is ready to do real work: install toolchains, run test suites, click
through a staging site, leave a build running overnight. But it's stuck on the
one machine it was started on, or in someone else's cloud, while the desktop with
the RAM for the full build and the Mac mini on the shelf sit idle. Handing it SSH
would get it there, along with your account, your files and your keys.

Localbox lets every agent you run, on your laptop, in the cloud or on a schedule,
work on every Mac you own. Each one gets a **sandbox** there: a whole Linux
computer with a shell, files, a browser and a desktop, that stays exactly as the
agent left it. It never gets your account, and sees none of your files unless you
share a folder. **Claude Code, Codex, or any agent harness** drives it through one
CLI, with an optional MCP endpoint.

**Every computer you own, for every agent you run. Free.**

**[Get started →](#get-started)** Your agent installs it for you.

## Things you can ask for

> "Use the Mac mini in the closet for tonight's full build."

> "Run the integration tests on my desktop at home, then open the PR."

> "Give each of these three branches its own sandbox, on whichever Macs have room."

> "Run this with permissions off, inside a sandbox, not on my laptop."

> "Pick up where we left off yesterday. The dev server should still be running."

> "Spin up a sandbox, clone this repo and get the tests passing."

## Your machines are the fleet

<p align="center">
  <img src=".github/readme/05-your-machines-are-the-fleet.png" alt="Xiaohei hands a sandbox from a shelf of home computers to the agent, while the cloud bill is crossed out" width="85%">
</p>

You probably own more compute than your agent uses: a desktop with the RAM for
the full build, a Mac mini on the shelf, last year's laptop. Sign each one in with
your email and it joins your fleet, even from another country. Sandboxes stay on
the machine your agent is running on unless it asks otherwise: name a machine, or
let Localbox pick whichever has the most room. Start with the Mac you have; every
Mac you add joins. No per-minute billing, no session limit, and your code never
leaves hardware you own.

## Cloud agents, your computers

<p align="center">
  <img src=".github/readme/03-outbound-only.png" alt="The Mac's front door stays padlocked while a line runs from the roof to the relay" width="85%">
</p>

Background agents like Codex cloud, Claude Code on the web and scheduled agents
reach your computers from wherever they run, and do their work in your sandboxes
instead of rented ones. Each Mac connects **out** to a hosted relay, so there's no
port forwarding, VPN, Tailscale or SSH key. A cloud agent signs in with your
email and a code, gets a token for your account that you can revoke any time, and a
request that may have half-applied is reported as uncertain, never silently
retried.

## A sandbox, not your account

<p align="center">
  <img src=".github/readme/04-host-stays-outside.png" alt="The agent builds freely inside a glass jar while your files sit untouched outside it" width="85%">
</p>

SSH would hand your agent your account on every machine: your files, your keys,
your logged-in sessions. Localbox hands it a sandbox instead. And the fastest
agents run with permission prompts off, which is exactly what nobody wants on
their own laptop. Inside a sandbox, let it. The sandbox is the boundary,
so there's nothing inside worth prompting about: install anything, run untrusted
scripts, break things. The worst case is deleting the sandbox. Each sandbox is a
full Linux virtual machine on Apple's own Virtualization framework, the one built
into macOS, with its own kernel, disk and network.

## Share a folder, see every access

<p align="center">
  <img src=".github/readme/06-share-a-folder.png" alt="One shared folder reaches the sandbox through a tube while Xiaohei logs every access in a ledger" width="85%">
</p>

A sandbox sees nothing on your Mac until you say so. Your agent shares exactly
the folder it needs, read-only unless you say otherwise, and Localbox logs every
file the sandbox reads or writes through it. Your processes, credentials and
screen are never shared. The [security model](SECURITY.md) spells out the boundary.

## Still set up next week

<p align="center">
  <img src=".github/readme/01-still-there-next-week.png" alt="The agent leaves its desk at the end of a session and finds everything exactly where it left it" width="85%">
</p>

Close your laptop and the work keeps going. Cloud sandboxes and containers are
built to be thrown away, so every session starts by reinstalling the world. A Localbox sandbox keeps its files, installed
packages, browser profile and desktop across sessions, sleep and reconnects. Set
it up once and it's still set up next week.

Durable doesn't mean always running. A sandbox nobody has used for 30 minutes
goes to sleep, and the next request wakes it with every process exactly where it
was, down to the dev server it left running. When a sandbox should be disposable,
give it an idle timeout and it deletes itself once nobody's using it. Nothing to
prune.

## One catalog, two ways in

<p align="center">
  <img src=".github/readme/02-two-handles-one-door.png" alt="One door with a CLI knob and an MCP handle; the same operations wait behind it" width="85%">
</p>

The CLI is the product, and its customer is your agent. MCP is an adapter over
the same operation catalog, with identical operations, schemas, errors and
permissions, so a request means the same thing from a shell, Claude Code, Codex or
a script. Every command does what it was asked when the result can be undone, then
says exactly what it did: the size and machine it chose, the sandboxes it slept to
make room, the output it trimmed. Your agent never has to guess.

| | What your agent can use |
| --- | --- |
| **Sandboxes** | Create, list, rename, resize, sleep, wake and delete; sized to the machine, durable by default, optional idle deletion |
| **Machines** | Sign in with an email code; list, rename and remove machines; place sandboxes locally, on a named machine, or automatically |
| **Shell** | Run bounded commands, or start long jobs and wait, poll, cancel or read their output |
| **Files** | List, read, write, create and remove paths inside the sandbox |
| **Browser** | Open, navigate and close tabs; click, type, send keys and take screenshots |
| **Desktop** | Screenshot, move, click, scroll and type on a 1440×900 virtual display |
| **Shared folders** | Share a host folder read-only or read-write, and read its access log |

## Get started

Requires **Apple Silicon and macOS 14 or newer**. Free.

Open Claude Code or Codex and say:

> Install Localbox for me by following https://localbox.sh/llms.txt

Then ask for something that needs a sandbox. The [agent setup](#agent-setup)
below is what your agent follows.

## Agent setup

Your agent follows the [installation procedure](skills/localbox/references/installation.md):
one signed release, verified, then its own installer, which sets up the CLI, the
background services and the [Localbox skill](skills/localbox/SKILL.md). Updates
and keeping the skill current are covered in the
[skill lifecycle](skills/localbox/references/skill-lifecycle.md).

## Contributing

Localbox is an npm workspace monorepo: `apps/*` holds product surfaces (CLI,
macOS host daemon, guest agent, relay, MCP, website) and `packages/*` holds the
shared contract, runtime and protocol owners.

```sh
npm install
npm run build
npm test
```

The [positioning](positioning.md) doc holds the product message and use cases.
The [development guide](DEVELOPMENT.md) records the principles behind the public
contracts, plus local control-plane smoke tests, deployment configuration and the
release process. The [security model](SECURITY.md) defines the trust boundaries,
and the [rationale](specs/done/agent-computer/README.md) explains why the system
has this shape. The [website](apps/site/README.md) is the public page at
[localbox.sh](https://localbox.sh), with the same instructions as plain text for
agents. README artwork lives in [.github/readme](.github/readme).
