// Every word on the site. The page, its agent view and /llms.txt all render from here.
export const repo = "https://github.com/dzhng/localbox";
const blob = `${repo}/blob/main`;

/** Must match the prompt quoted in the README's "Get started" section; the build checks. */
export const agentPrompt = "Install Localbox for me by following https://localbox.sh/llms.txt";

export const openIn = [
  { label: "Open in Claude Code", href: `claude-cli://open?q=${encodeURIComponent(agentPrompt)}` },
  { label: "Open in Codex", href: `codex://new?prompt=${encodeURIComponent(agentPrompt)}` },
];

export const requirements = "Apple Silicon · macOS 14 or newer";

export const links = {
  repo,
  releases: `${repo}/releases/latest`,
  agentSetup: `${repo}#agent-setup`,
  installation: `${blob}/skills/localbox/references/installation.md`,
  skill: `${blob}/skills/localbox/SKILL.md`,
  security: `${blob}/SECURITY.md`,
  development: `${blob}/DEVELOPMENT.md`,
};

export const meta = {
  title: "Localbox — durable sandboxes for your agent",
  description:
    "Localbox turns your Mac, or a shelf of Mac minis, into durable sandboxes that Claude Code, Codex and any agent create, use and delete on their own. Free.",
  imageAlt: "Xiaohei slides a sandbox out of a shelf of home computers and sends it to your agent",
};

export const hero = {
  kicker: "for Claude Code, Codex & any agent",
  title: "Durable sandboxes",
  accent: "for your agent.",
  lede: "On computers you already own. Localbox turns your Mac, or a shelf of Mac minis, into sandboxes your agent creates, uses and deletes on its own, each a whole Linux computer that stays exactly as the agent left it.",
};

/** The honest pitch: what each place to run an agent actually gives you. */
export const compare = {
  title: "No container tax, no sandbox bill",
  body: "Docker on a Mac claims gigabytes of RAM the moment it starts and leaves containers to prune. Cloud sandboxes bill monthly, cap sessions and hold your code. Localbox runs on the machines you already own.",
  columns: ["Docker on your Mac", "Cloud sandbox", "Localbox"],
  rows: [
    { label: "Its own kernel, isolated from your Mac", values: [false, true, true] },
    { label: "Keeps its state between sessions", values: [true, false, true] },
    { label: "Reachable from cloud agents", values: [false, true, true] },
    { label: "No monthly bill or session limit", values: [true, false, true] },
    { label: "Code stays on your machines", values: [true, false, true] },
  ],
};

export const asks = [
  "Spin up a sandbox, clone this repo and get the tests passing.",
  "Run this with permissions off, inside a sandbox, not on my laptop.",
  "Give each of these three branches its own sandbox and dev server.",
  "Use the Mac mini in the closet for tonight's full build.",
  "Share ~/code/app read-only with the sandbox, then show me every file it read.",
  "Pick up where we left off yesterday. The dev server should still be running.",
  "That sandbox is too small for the full test suite. Give it 8 GB.",
];

/** Illustrations live in .github/readme and are copied to /art at build time. */
export const features = [
  {
    image: "01-still-there-next-week.png",
    alt: "Xiaohei goes to bed beside its desk, then comes back to find every tool and tab exactly where it was",
    kicker: "durable",
    title: "Still set up next week",
    body: "A sandbox keeps its files, installed packages, browser profile and desktop until someone deletes it. Idle for 30 minutes, it goes to sleep and gives your RAM back; the next request wakes it with every process where it was, dev server included. Want one disposable? Give it an idle timeout.",
  },
  {
    image: "05-your-machines-are-the-fleet.png",
    alt: "Xiaohei hands a sandbox from a shelf of home computers to the agent, while the cloud bill is crossed out",
    kicker: "your fleet",
    title: "Your machines are the fleet",
    body: "Sign in on each Mac you own with your email and it joins your fleet, even from another country. Sandboxes stay on your agent's machine unless it names another or asks Localbox to pick the roomiest. No per-minute billing, no session limit.",
  },
  {
    image: "03-outbound-only.png",
    alt: "The house's front door stays padlocked while Xiaohei sits on the roof reeling a line up to the relay",
    kicker: "outbound only",
    title: "Cloud agents, your computers",
    body: "Codex cloud, Claude Code on the web and other background agents work in your sandboxes through a relay your Mac connects out to: no port forwarding, VPN or Tailscale. They sign in with your email and a code, and you can revoke them any time.",
  },
  {
    image: "04-host-stays-outside.png",
    alt: "Xiaohei builds freely inside a glass jar while your files sit untouched outside it",
    kicker: "off the leash",
    title: "Permissions off, safely",
    body: "Run your agent with permission prompts off inside a sandbox. Install anything, run untrusted scripts, break things. The sandbox is the boundary, and the worst case is deleting it.",
  },
  {
    image: "06-share-a-folder.png",
    alt: "One shared folder reaches the sandbox through a tube while Xiaohei logs every access in a ledger",
    kicker: "audited",
    title: "Share a folder, see every access",
    body: "A sandbox sees nothing on your Mac by default. Share exactly the folder your agent needs, read-only unless you say otherwise, and Localbox logs every file it reads or writes.",
  },
];

export const capabilities = [
  { area: "Sandboxes", body: "Create, rename, resize, sleep, wake and delete. Sized to the machine, durable by default, optional idle deletion." },
  { area: "Machines", body: "Sign in with an email code. Place sandboxes locally, on a named machine, or automatically." },
  { area: "Shell", body: "Run bounded commands, or start long jobs and wait, poll, cancel or read their output." },
  { area: "Files", body: "List, stat, read, write, create and remove paths inside the sandbox." },
  { area: "Browser and desktop", body: "Open and drive browser tabs; click, type, scroll and screenshot a 1440×900 virtual desktop." },
  { area: "Shared folders", body: "Share a host folder read-only or read-write, and read its access log." },
];

export const humanSteps = [
  { title: "Paste the prompt into Claude Code or Codex", body: "Or use an Open button above; it fills in the prompt without sending it." },
  { title: "Your agent installs a signed release", body: "It verifies checksums and the release signature, then installs the CLI, the Localbox skill and a small host daemon. Nothing to drag into Applications." },
  { title: "Ask for something that needs a sandbox", body: "The agent creates one and works in it. Updates install themselves and verify before replacing anything." },
];

export const faq = [
  {
    q: "Is it really free?",
    a: "Yes. It runs on machines you already own, so there's nothing to rent. You sign in with your email so your machines and sandboxes belong to one account.",
  },
  {
    q: "Doesn't a VM eat my RAM?",
    a: "Only while it's working. A sandbox idle for 30 minutes goes to sleep: its memory is saved to disk and the RAM comes back to you. The next request wakes it in seconds with every process exactly where it was.",
  },
  {
    q: "How do I sign in?",
    a: "With your email and a 6-digit code. No password. Your agent runs the login and asks you for the code. Sign in with the same email on another Mac and it joins the same account.",
  },
  {
    q: "Can a sandbox see my files?",
    a: "Not unless you share a folder with it. Shares are read-only by default, every access through them is logged, and your processes, credentials and screen are never shared.",
  },
  {
    q: "How is this different from Docker?",
    a: "A container shares a kernel and is built to be thrown away. A sandbox is a whole Linux computer with its own desktop and browser, durable until deleted, and your agent manages its whole lifecycle. Docker even runs inside one.",
  },
  {
    q: "Do I need MCP?",
    a: "No. The CLI is the whole product and works on its own. Add MCP only when a client wants tool discovery; it exposes exactly the same operations.",
  },
  {
    q: "What can the relay see?",
    a: "The relay only matters when your agent runs somewhere other than your Macs. It authenticates, bounds and forwards requests, and in this version it can observe their contents. The security model states that trust explicitly.",
  },
  {
    q: "What works today?",
    a: "Today one Mac runs one durable sandbox with shell, files, browser and desktop, the CLI and optional MCP, and the outbound relay. Creating sandboxes on demand, sleep and idle deletion, sizing, multi-machine fleets and placement, email sign-in and shared folders are in progress.",
  },
];

/** Plain-text instructions for agents: served as /llms.txt and as the page's agent view. It sells and installs; the bundled skill teaches use. */
export function llmsText() {
  return `# Localbox

> Durable sandboxes for AI agents, on computers the user already owns. Localbox turns the user's Mac, or a shelf of Mac minis, into Linux sandboxes that you, the agent, create, use and delete on your own: a shell, files, a browser and a desktop, kept exactly as you left them.

## Why use it

- **Durable.** Installed packages, files, browser profiles and running processes survive across sessions. Idle sandboxes sleep and wake with every process intact.
- **Safe to run with permissions off.** The sandbox is the boundary; the user's own files, credentials and screen are not shared with it.
- **The user's hardware, not a rented cloud sandbox.** No per-minute bill, no session limit, and the code stays on machines the user owns. Cloud agents reach those machines through an outbound relay.
- **Built for agents.** One CLI, with MCP as an option. Every command reports exactly what it did.
- **Free.**

Requirements: ${requirements.replaceAll(" · ", ", ")}.

## Install

When the user asks you to install Localbox, follow the [agent installation procedure](${links.installation}). It downloads one signed GitHub release, verifies it against the pinned release key, and runs the bundled installer. Do not build from source; there is no browser download.

The installer sets up the \`localbox\` CLI, a small background service, and the **Localbox skill** for every agent harness it finds. The skill updates itself with every Localbox update.

## After installing

Start a fresh session so the Localbox skill is loaded, then read it. It is the reference for everything you do with Localbox; this file is not.

## Links

- [Repository](${links.repo})
- [Latest release](${links.releases})
- [Localbox skill](${links.skill})
- [Security model](${links.security})
`;
}
