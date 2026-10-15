// Every word on the site. The page, its agent view and /llms.txt all render from here.
export const repo = "https://github.com/dzhng/localbox";
const blob = `${repo}/blob/main`;

/** Must match the prompt quoted in the README's "Get started" section; the build checks. */
export const agentPrompt = "Install Localbox for me by following https://localbox.sh/llms.txt";

export const openIn = [
  { label: "Open in Claude Code", href: `claude-cli://open?q=${encodeURIComponent(agentPrompt)}` },
  { label: "Open in Codex", href: `codex://new?prompt=${encodeURIComponent(agentPrompt)}` },
];

export const requirements = "Apple Silicon · macOS 13 or newer";

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
  title: "Localbox — a computer your agent can use",
  description:
    "Localbox gives Claude Code, Codex and any agent a durable Linux computer on your Mac: shell, files, browser and desktop through one CLI, with optional MCP.",
  imageAlt: "Xiaohei sits in a little house on a laptop, typing on its own tiny computer",
};

export const hero = {
  kicker: "for Claude Code, Codex & any agent",
  title: "Your agent gets a computer.",
  accent: "You keep yours.",
  lede: "Localbox runs a durable Linux VM on your Mac and hands it to your agent: a shell, files, a browser and a desktop that are still set up next week.",
};

/** The honest pitch: what each place to run an agent actually gives you. */
export const compare = {
  title: "A computer, not a sandbox",
  body: "Your laptop is too precious to hand over. A cloud sandbox forgets everything when the session ends. Localbox is the agent's own machine.",
  columns: ["Your laptop", "Cloud sandbox", "Localbox"],
  rows: [
    { label: "Keeps installs, files and browser state", values: [true, false, true] },
    { label: "Keeps the agent away from your files", values: [false, true, true] },
    { label: "Reachable from a remote agent", values: [false, true, true] },
    { label: "Runs on hardware you own", values: [true, false, true] },
  ],
};

export const asks = [
  "Install Postgres and Node in the VM and get this repo's tests passing.",
  "Open the staging site in the VM's browser and click through checkout.",
  "Run this untrusted script somewhere that isn't my laptop.",
  "Kick off the full build and screenshot the desktop when it's done.",
  "Pick up where we left off yesterday. The dev server should still be there.",
  "Connect from my cloud agent and run the integration suite on my Mac.",
];

/** Illustrations live in .github/readme and are copied to /art at build time. */
export const features = [
  {
    image: "01-still-there-next-week.png",
    alt: "Xiaohei goes to bed beside its desk, then comes back to find every tool and tab exactly where it was",
    kicker: "durable",
    title: "Still set up next week",
    body: "Files, installed packages, browser profiles and desktop state persist across sessions, sleep, VM stops and reconnects. Set it up once; the next session, or the next agent, starts where the last one stopped.",
  },
  {
    image: "02-two-handles-one-door.png",
    alt: "One door with a CLI knob and an MCP handle, and Xiaohei holding the single key",
    kicker: "one catalog",
    title: "Two handles, one door",
    body: "The CLI is the product. MCP is an optional adapter over the same operation catalog, with identical operations, schemas, errors and permissions. `localbox help` and the MCP tool list are generated from one source.",
  },
  {
    image: "03-outbound-only.png",
    alt: "The house's front door stays padlocked while Xiaohei sits on the roof reeling a line up to the relay",
    kicker: "outbound only",
    title: "Reachable from anywhere, open to nothing",
    body: "Locally the CLI talks to the daemon over an authenticated socket. Remote agents go through a hosted relay that your Mac connects out to: no port forwarding, no VPN, no Tailscale. OAuth access can be revoked at any time.",
  },
  {
    image: "04-host-stays-outside.png",
    alt: "Xiaohei builds freely inside a glass jar while your files sit untouched outside it",
    kicker: "the boundary",
    title: "Your Mac stays outside",
    body: "The VM is the security boundary. Inside, an authorized agent can do anything a shell can, so there are no per-tool prompts to click through. Your files, processes, credentials and screen are not shared with it.",
  },
];

export const capabilities = [
  { area: "Lifecycle", body: "Start, stop, pause and reset the VM. Read status, logs and egress identity." },
  { area: "Shell", body: "Run bounded commands, or start long jobs and wait, poll, cancel or read their output." },
  { area: "Files", body: "List, stat, read, write, create and remove paths inside the VM." },
  { area: "Browser", body: "Open, navigate, focus and close tabs. Click, type, send keys, take screenshots." },
  { area: "Desktop", body: "Screenshot, move, click, scroll and type on a 1440×900 virtual display." },
];

export const humanSteps = [
  { title: "Paste the prompt into Claude Code or Codex", body: "Or use an Open button above; it fills in the prompt without sending it." },
  { title: "Your agent installs a signed release", body: "It verifies checksums and the release signature, then installs the CLI, the Localbox skill and a small host daemon. Nothing to drag into Applications." },
  { title: "Ask for something that needs a computer", body: "The agent starts the VM and works in it. Updates install themselves and verify before replacing anything." },
];

export const faq = [
  {
    q: "Do I need MCP?",
    a: "No. The CLI is the whole product and works on its own. Add MCP only when a client wants tool discovery; it exposes exactly the same operations.",
  },
  {
    q: "What can the relay see?",
    a: "The relay only matters when your agent runs somewhere other than your Mac. It authenticates, bounds and forwards requests, and in this version it can observe their contents. The security model states that trust explicitly.",
  },
  {
    q: "What happens to the VM when Localbox updates?",
    a: "Nothing. Updates replace the app and CLI, never the VM's disk. Rollback and uninstall keep the VM's state too. Only an explicit, confirmed reset discards it.",
  },
  {
    q: "Is it the same as a dev container?",
    a: "No. It is a whole Linux computer with a desktop and a browser, built for an agent to live in rather than for one project's toolchain.",
  },
  {
    q: "Can I use it today?",
    a: "Localbox is pre-release. The install prompt works as soon as the first signed release is published on GitHub.",
  },
];

/** Plain-text instructions for agents: served as /llms.txt and as the page's agent view. */
export function llmsText() {
  return `# Localbox

> Localbox gives an AI agent a durable Linux VM on the user's Apple Silicon Mac: shell, filesystem, browser and desktop through one CLI. MCP is an optional adapter over the same operation catalog.

Requirements: ${requirements.replaceAll(" · ", ", ")}. Localbox is pre-release; installation needs a published GitHub release.

## Install

When the user asks you to install Localbox, follow the [agent installation procedure](${links.installation}). In short: resolve one stable tag from GitHub Releases, download the release kit with \`release.json\` and \`SHA256SUMS\`, verify both against the pinned Ed25519 release key, and run the bundled installer. Do not build from source, and there is no browser download.

The installer places the CLI at \`~/.local/bin/localbox\`, registers the host daemon and a six-hour updater with launchd, and installs the global Localbox skill. It carries its own Node runtime and never calls host \`npx\` or \`npm\`. Verify with:

    ~/.local/bin/localbox status
    ~/.local/bin/localbox skill status --json
    ~/.local/bin/localbox help --json

## Use

- \`localbox vm start\`, \`localbox vm stop\` and \`localbox status\` manage the computer.
- \`localbox shell exec -- <command>\` runs a bounded command in the VM.
- \`localbox help\` lists every operation; it is generated from the shared catalog.
- \`localbox auth login\` authenticates remote relay use; it is independent of MCP.
- \`localbox mcp install --json\` prints optional MCP configuration.
- The [Localbox skill](${links.skill}) covers everyday use and recovery.

## Rules

- Never repeat a mutation blindly after an \`operation_uncertain\` result. Query status or replay the same mutation ID.
- \`vm reset --discard-state\` deletes all guest state. Run it only after the user explicitly confirms.
- The VM is the security boundary. The host's files are not available inside it.

## Links

- [Repository](${links.repo})
- [Latest release](${links.releases})
- [Agent setup](${links.agentSetup})
- [Security model](${links.security})
`;
}
