// Every word on the site. The page, its agent view and /llms.txt all render from here.
export const repo = "https://github.com/dzhng/localbox";
const blob = `${repo}/blob/main`;

/** Must match the prompt quoted in the README's "Get started" section; the build checks. */
export const agentPrompt = "Install Localbox for me by following https://localbox.sh/llms.txt";

export const openIn = [
  { label: "Open in Claude Code", href: `claude-cli://open?q=${encodeURIComponent(agentPrompt)}` },
  { label: "Open in Codex", href: `codex://new?prompt=${encodeURIComponent(agentPrompt)}` },
];

export const requirements = "Apple Silicon · macOS 14 or newer (macOS 27 for macOS sandboxes)";

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
  title: "Localbox — stop renting sandboxes, you already own them",
  description:
    "Localbox turns every Mac you own into sandboxes for your agents: Linux or macOS, set up your way, and still there next week. For Claude Code, Codex and any agent. Free.",
  imageAlt: "Xiaohei slides a sandbox out of a shelf of computers you own and sends it to your agent",
};

export const hero = {
  kicker: "for Claude Code, Codex & any agent",
  title: "Stop renting sandboxes.",
  accent: "You already own\u00a0them.",
  lede: "Localbox turns every Mac you own into sandboxes for your agents: Linux or macOS, set up your way, and still there next week. Free.",
};

/** The honest pitch: what renting a sandbox, SSH, and Localbox each actually give you. */
export const compare = {
  title: "Better than renting, safer than SSH",
  body: "A cloud sandbox keeps your agent off your laptop, but you rent it by the minute, it forgets everything when the session ends, and it's nowhere near your machines. SSH and Tailscale reach the Macs you own once you've set up keys and a network on each, and then your agent has your whole computer: your files, keys and logged-in sessions. Localbox gives every agent a sandbox on every Mac you own, set up with your email and a 6-digit code emailed to you.",
  columns: ["Cloud sandbox", "SSH and Tailscale", "Localbox"],
  rows: [
    { label: "Runs on the computers you already own", values: [false, true, true] },
    { label: "No per-minute bill or session limit", values: [false, true, true] },
    { label: "Keeps its setup between sessions", values: [false, true, true] },
    { label: "Safe with permission prompts off", values: [true, false, true] },
    { label: "Your files out of reach unless you share them", values: [true, false, true] },
    { label: "Reachable from cloud agents, no open port or VPN", values: [true, false, true] },
  ],
};

export const asks = [
  "Use the Mac mini in the closet for tonight's full build.",
  "Set up a sandbox with our toolchain and make it my default image.",
  "Give each of these three branches its own sandbox, on whichever Macs have room.",
  "Open a macOS sandbox, install Xcode with my Apple ID, and run the iOS tests.",
  "Run this with permissions off, inside a sandbox, not on my laptop.",
  "Pick up where we left off yesterday. The dev server should still be running.",
];

/** Illustrations live in .github/readme and are copied to /art at build time. */
export const features = [
  {
    image: "05-your-machines-are-the-fleet.png",
    alt: "Xiaohei hands a sandbox from a shelf of home computers to the agent",
    kicker: "owned, not rented",
    title: "Every Mac you own, already paid for",
    body: "A cloud sandbox is someone else's computer by the minute, wiped when the session ends. Sign in on each Mac you own with your email and it joins, even from another country. Your agent works on the Mac it's on, names another, or lets Localbox pick the one with the most room. Start with the Mac you have; every Mac you add joins. No per-minute billing, no session limit.",
  },
  {
    image: "01-still-there-next-week.png",
    alt: "Xiaohei goes to bed beside its desk, then comes back to find every tool and tab exactly where it was",
    kicker: "saved setups",
    title: "Set up your way, still there next week",
    body: "A sandbox keeps its files, installed packages, browser profile and desktop until someone deletes it. Save one as an image and every new sandbox can start from it, on any of your Macs: images copy straight from Mac to Mac, never through anyone's cloud. Idle sandboxes sleep and wake with every process where it was, dev server included.",
  },
  {
    image: "04-host-stays-outside.png",
    alt: "Xiaohei builds freely inside a glass jar while your files sit untouched outside it",
    kicker: "Linux or macOS",
    title: "A sandbox, not your whole computer",
    body: "Each sandbox is a computer of its own, Linux or macOS, with a shell, files, a browser and a desktop. macOS sandboxes are for Xcode work and Mac apps: Localbox builds the base on your own Mac from Apple's restore image. SSH would hand your agent yours; a sandbox lets it run with permission prompts off, and the worst case is deleting the sandbox.",
  },
  {
    image: "03-outbound-only.png",
    alt: "The house's front door stays padlocked while Xiaohei sits on the roof reeling a line up to the relay",
    kicker: "from anywhere",
    title: "Cloud agents, your computers",
    body: "Codex cloud, Claude Code on the web and scheduled agents reach your Macs through a relay they connect out to: no port forwarding, VPN, Tailscale or SSH keys. They sign in with your email and a 6-digit code emailed to you, and you can revoke them any time.",
  },
  {
    image: "06-share-a-folder.png",
    alt: "One shared folder reaches the sandbox through a tube while Xiaohei logs every access in a ledger",
    kicker: "audited",
    title: "Share a folder, see every access",
    body: "A sandbox sees nothing on your Mac until you say so. Share exactly the folder your agent needs, read-only unless you say otherwise, and Localbox logs every file it reads or writes.",
  },
];

export const capabilities = [
  { area: "Sandboxes", body: "Linux or macOS. Create, rename, resize, sleep, wake and delete. Sized to the machine, durable by default, optional idle deletion." },
  { area: "Images", body: "Save any sandbox as an image, make one the default, copy it straight between your Macs, and start new sandboxes from it." },
  { area: "Machines", body: "Sign in with an email code. Place sandboxes locally, on a named machine, or automatically." },
  { area: "Shell and files", body: "Run commands with a time limit, or long jobs you can wait on, check and cancel; list, read, write and remove files." },
  { area: "Browser and desktop", body: "Open and drive browser tabs; click, type, scroll and screenshot a 1440×900 desktop, Linux or macOS." },
  { area: "Shared folders", body: "Share a folder from your Mac, read-only or read-write, and read its access log." },
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
    a: "A running sandbox reserves memory like any VM. A sandbox idle for 30 minutes goes to sleep and wakes on the next request with every process where it was, and when a Mac is full it puts the idle sandboxes used longest ago to sleep to make room, and tells your agent which. Asleep, it saves its memory to disk and gives the RAM back; the installer checks your Mac is set up for it.",
  },
  {
    q: "How do I sign in?",
    a: "With your email and a 6-digit code. No password. Your agent runs the login and asks you for the code. Sign in with the same email on another Mac and it joins the same account.",
  },
  {
    q: "How are sandboxes isolated?",
    a: "Each sandbox is a full Linux or macOS virtual machine run by Apple's own Virtualization framework, the one built into macOS, not a container, an emulator or a third-party hypervisor. It has its own kernel, disk and network, so nothing inside it reaches your Mac except a folder you choose to share.",
  },
  {
    q: "Can a sandbox run macOS?",
    a: "Yes, on a Mac running macOS 27 or newer. Localbox builds the macOS base on your own Mac from Apple's restore image, with nothing for you to click through, and installs Chrome. Xcode needs your Apple ID, so your agent installs it once in a macOS sandbox and saves that as an image. Apple's licence allows two macOS sandboxes running at a time on each Mac, for your own development and testing.",
  },
  {
    q: "How do images get to my other Macs?",
    a: "Directly from one of your Macs to another: over your local network when they share one, otherwise over a direct connection between the two across the internet. Image bytes never pass through the relay or any cloud storage. Ask for a sandbox on a Mac without the image and it's copied there first.",
  },
  {
    q: "Can a sandbox see my files?",
    a: "Only a folder you share with it, read-only unless you say otherwise, and Localbox logs every file it reads or writes. Your processes, credentials and screen are never shared.",
  },
  {
    q: "How is this different from Docker?",
    a: "A container shares a kernel and is built to be thrown away. A sandbox is a whole computer, Linux or macOS, with its own desktop and browser, durable until deleted, and your agent manages its whole lifecycle. Docker even runs inside a Linux one.",
  },
  {
    q: "Do I need MCP?",
    a: "No. The CLI is the whole product and works on its own. Add MCP only when a client wants tool discovery; it exposes exactly the same operations.",
  },
  {
    q: "What can the relay see?",
    a: `The relay only matters when your agent runs somewhere other than your Macs. It checks who is asking and passes the request to your Mac; like any relay, it could read what passes through it. The [security model](${links.security}) spells out exactly what it is trusted with.`,
  },
];

/** Plain-text instructions for agents: served as /llms.txt and as the page's agent view. It sells and installs; the bundled skill teaches use. */
export function llmsText() {
  return `# Localbox

> Stop renting sandboxes. The user already owns them. Localbox turns every Mac the user owns into sandboxes for you, the agent: Linux or macOS, set up the user's way, and still there next week. Free.

## Why use it

- **The user's hardware, not a rented cloud sandbox.** No per-minute bill, no session limit, nothing wiped when the session ends, and the code stays on machines the user owns.
- **All the user's computers.** Wherever you run, on the user's laptop or in the cloud, work on the Mac you're on, name another, or let Localbox pick the Mac with the most room. Cloud agents reach the user's Macs through an outbound relay, with no open port, VPN or SSH key.
- **A computer of its own, Linux or macOS.** A shell, files, a browser and a desktop. macOS sandboxes are for Xcode work and Mac apps, on the user's own Macs.
- **Set up once.** Save any sandbox as an image and start new sandboxes from it; images copy directly between the user's Macs.
- **A sandbox, not the user's whole computer.** Safe to run with permissions off: the sandbox is the boundary, and the user's own files, credentials and screen are not shared with it.
- **Durable.** Installed packages, files and browser profiles survive across sessions. Idle sandboxes sleep and wake with every process intact.
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
