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
  title: "Localbox — give your agents all your computers",
  description:
    "Every agent you run, on your laptop or in the cloud, can work on every Mac you own, each in a sandbox of its own instead of your whole computer. For Claude Code, Codex and any agent. Free.",
  imageAlt: "Xiaohei slides a sandbox out of a shelf of home computers and sends it to your agent",
};

export const hero = {
  kicker: "for Claude Code, Codex & any agent",
  title: "Give your agents",
  accent: "all your computers.",
  lede: "Every agent you run, on your laptop, in the cloud or on a schedule, can work on every Mac you own. Each one gets a sandbox there: a whole Linux computer of its own that stays as the agent left it. Never your whole computer, and none of your files unless you share them.",
};

/** The honest pitch: what each way of giving an agent more computers actually gives you. */
export const compare = {
  title: "The reach of SSH, without handing over your computer",
  body: "SSH gives your agent every machine you open to it, along with your files, keys and logged-in sessions. A cloud sandbox keeps it safe, far from your machines and on a monthly bill. Localbox gives every agent a sandbox on every Mac you own.",
  columns: ["SSH into your Macs", "Cloud sandbox", "Localbox"],
  rows: [
    { label: "Works on the computers you own", values: [true, false, true] },
    { label: "Reachable from cloud agents, no open port or VPN", values: [false, true, true] },
    { label: "Safe with permission prompts off", values: [false, true, true] },
    { label: "Your files out of reach unless you share them", values: [false, true, true] },
    { label: "Keeps its state between sessions", values: [true, false, true] },
    { label: "No monthly bill or session limit", values: [true, false, true] },
  ],
};

export const asks = [
  "Use the Mac mini in the closet for tonight's full build.",
  "Run the integration tests on my desktop at home, then open the PR.",
  "Give each of these three branches its own sandbox, on whichever Macs have room.",
  "Run this with permissions off, inside a sandbox, not on my laptop.",
  "Pick up where we left off yesterday. The dev server should still be running.",
  "Spin up a sandbox, clone this repo and get the tests passing.",
];

/** Illustrations live in .github/readme and are copied to /art at build time. */
export const features = [
  {
    image: "05-your-machines-are-the-fleet.png",
    alt: "Xiaohei hands a sandbox from a shelf of home computers to the agent, while the cloud bill is crossed out",
    kicker: "every Mac you own",
    title: "Your machines are the fleet",
    body: "Sign in on each Mac you own with your email and it joins, even from another country. Your agent works on the machine it's on, names another, or asks Localbox for the roomiest. Start with the Mac you have; every Mac you add joins. No per-minute billing, no session limit.",
  },
  {
    image: "03-outbound-only.png",
    alt: "The house's front door stays padlocked while Xiaohei sits on the roof reeling a line up to the relay",
    kicker: "from anywhere",
    title: "Cloud agents, your computers",
    body: "Codex cloud, Claude Code on the web and scheduled agents reach your Macs through a relay they connect out to: no port forwarding, VPN, Tailscale or SSH keys. They sign in with your email and a code, and you can revoke them any time.",
  },
  {
    image: "04-host-stays-outside.png",
    alt: "Xiaohei builds freely inside a glass jar while your files sit untouched outside it",
    kicker: "not SSH",
    title: "A sandbox, not your whole computer",
    body: "SSH would hand your agent your whole computer. Localbox hands it a sandbox, so run it with permission prompts off: install anything, run untrusted scripts, break things. The sandbox is the boundary, and the worst case is deleting it.",
  },
  {
    image: "06-share-a-folder.png",
    alt: "One shared folder reaches the sandbox through a tube while Xiaohei logs every access in a ledger",
    kicker: "audited",
    title: "Share a folder, see every access",
    body: "A sandbox sees nothing on your Mac until you say so. Share exactly the folder your agent needs, read-only unless you say otherwise, and Localbox logs every file it reads or writes.",
  },
  {
    image: "01-still-there-next-week.png",
    alt: "Xiaohei goes to bed beside its desk, then comes back to find every tool and tab exactly where it was",
    kicker: "durable",
    title: "Still set up next week",
    body: "Close your laptop and the work keeps going. A sandbox keeps its files, installed packages, browser profile and desktop until someone deletes it. Idle for 30 minutes, it goes to sleep; the next request wakes it with every process where it was, dev server included. Want one disposable? Give it an idle timeout.",
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
    q: "Why not just give my agent SSH?",
    a: "SSH hands your agent your whole computer, on every machine you open to it: your files, keys and logged-in sessions, plus an open port or VPN to reach it. Localbox gives it a sandbox on that machine instead, reachable from anywhere through a connection your Mac makes out, so it can run with permissions off and the worst case is deleting the sandbox.",
  },
  {
    q: "Is it really free?",
    a: "Yes. It runs on machines you already own, so there's nothing to rent. You sign in with your email so your machines and sandboxes belong to one account.",
  },
  {
    q: "Doesn't a VM eat my RAM?",
    a: "A running sandbox reserves memory like any VM. A sandbox idle for 30 minutes goes to sleep and wakes on the next request with every process where it was, and a full Mac makes room from its least recently used idle sandboxes, telling your agent which. Asleep, it saves its memory to disk and gives the RAM back; the installer checks your Mac is set up for it.",
  },
  {
    q: "How do I sign in?",
    a: "With your email and a 6-digit code. No password. Your agent runs the login and asks you for the code. Sign in with the same email on another Mac and it joins the same account.",
  },
  {
    q: "How are sandboxes isolated?",
    a: "Each sandbox is a full Linux virtual machine run by Apple's own Virtualization framework, the one built into macOS, not a container, an emulator or a third-party hypervisor. It has its own kernel, disk and network, so nothing inside it can reach your Mac.",
  },
  {
    q: "Can a sandbox see my files?",
    a: "Only a folder you share with it, read-only unless you say otherwise, and Localbox logs every file it reads or writes. Your processes, credentials and screen are never shared.",
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
    a: "The relay only matters when your agent runs somewhere other than your Macs. It authenticates, bounds and forwards requests, and it can observe their contents. The security model states that trust explicitly.",
  },
];

/** Plain-text instructions for agents: served as /llms.txt and as the page's agent view. It sells and installs; the bundled skill teaches use. */
export function llmsText() {
  return `# Localbox

> Every computer the user owns, in reach of you, the agent. Wherever you run, on the user's laptop or in the cloud, Localbox lets you open a sandbox on any Mac the user has signed in: a whole Linux computer with a shell, files, a browser and a desktop, kept exactly as you left it.

## Why use it

- **All the user's computers.** Work on the machine you're on, name another, or let Localbox pick the roomiest. Cloud agents reach the user's Macs through an outbound relay, with no open port, VPN or SSH key.
- **A sandbox, not the user's whole computer.** Safe to run with permissions off: the sandbox is the boundary, and the user's own files, credentials and screen are not shared with it.
- **Durable.** Installed packages, files and browser profiles survive across sessions. Idle sandboxes sleep and wake with every process intact.
- **The user's hardware, not a rented cloud sandbox.** No per-minute bill, no session limit, and the code stays on machines the user owns.
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
