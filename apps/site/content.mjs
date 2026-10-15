// One copy source for the human page, agent view and /llms.txt.
export const repo = "https://github.com/dzhng/localbox";
const raw = "https://raw.githubusercontent.com/dzhng/localbox/main";

export const agentPrompt =
  "Install Localbox for me by following https://localbox.sh/llms.txt";

export const openIn = [
  { label: "Open in Claude Code", href: `claude-cli://open?q=${encodeURIComponent(agentPrompt)}` },
  { label: "Open in Codex", href: `codex://new?prompt=${encodeURIComponent(agentPrompt)}` },
];

export const requirements = "Apple Silicon · macOS 13 or newer · agent-installed";

export const links = {
  repo,
  releases: `${repo}/releases/latest`,
  agentSetup: `${repo}#agent-setup`,
  installation: `${raw}/skills/localbox/references/installation.md`,
  skill: `${raw}/skills/localbox/SKILL.md`,
  mcp: `${repo}#product-direction`,
};

export const meta = {
  title: "Localbox — a computer your agent can use",
  description:
    "Localbox gives Claude Code, Codex and other agents a durable Linux VM on your Mac through a CLI, with optional MCP and a hosted outbound relay.",
};

export const asks = [
  "Install the tools I need and run the project tests.",
  "Open the browser in the VM and check the staging site.",
  "Run this command in an isolated Linux environment and show me the output.",
  "Take a screenshot of the desktop after the build finishes.",
  "Keep the VM state between sessions and reconnect after sleep.",
  "Use MCP for this task, but keep the CLI as the source of truth.",
];

export const howItWorks = [
  {
    visual: "terminal",
    title: "Tell your agent to install it",
    body: "The agent downloads one tagged release, verifies its checksums and signature, installs the CLI and skill, and registers the local daemon. No browser download or drag-and-drop step.",
  },
  {
    visual: "vm",
    title: "A durable computer boundary",
    body: "The VM keeps its files, installed programs, browser state and desktop state. The CLI speaks to one operation catalog for shell, filesystem, browser and desktop work.",
  },
  {
    visual: "relay",
    title: "Local by default, reachable when needed",
    body: "Localbox uses authenticated Unix-socket IPC on the Mac. When an agent is remote, the optional Vercel and Convex relay carries bounded requests out to the host without inbound port forwarding.",
  },
];

export const promises = [
  { title: "CLI first", body: "Every capability exposed through MCP is available from the Localbox CLI. MCP is an optional adapter, not a second product surface." },
  { title: "Durable state", body: "The computer keeps its files and installed tools across agent sessions, VM stops and reconnects." },
  { title: "Signed updates", body: "The release, CLI and managed skill update together from a verified GitHub release." },
  { title: "No invite flow", body: "Connect one agent or ten agents to the same MCP endpoint. Access is controlled by authenticated owner and VM credentials." },
];

export const humanSteps = [
  { title: "Paste the prompt into Claude Code or Codex", body: "Or click one of the open buttons above. Your agent follows the signed release installation procedure." },
  { title: "Localbox sets up the agent", body: "The release installs the CLI, bundled skill installer, PATH entry and launchd jobs. The skill refreshes after app updates." },
  { title: "Use the computer", body: "Run `localbox status`, start the VM, execute shell commands, and add MCP only when a client needs tool discovery." },
];

function bullets(items) { return items.map((item) => `- ${item}`).join("\n"); }

export function llmsText() {
  return `# Localbox

> Localbox gives Claude Code, Codex and other agents a durable Linux VM on an Apple Silicon Mac. The CLI is the primary interface; MCP is optional. The host daemon, VM and remote relay share one operation catalog.

Requirements: ${requirements.replaceAll(" · ", ", ")}. Linux hosts can use the protocol fixtures but cannot run the native macOS HostDaemon.

## Install

If the user asks you to install Localbox, follow this request:

    ${agentPrompt}

Use the [agent installation procedure](${links.installation}). Resolve one stable GitHub release tag, download the complete app and CLI kit plus \`release.json\` and \`SHA256SUMS\`, verify them with the pinned Ed25519 public key, and invoke the release installer. The agent installs the product; there is no browser app download step.

The installed release carries its own ARM64 Node runtime and pinned \`skills@1.7.0\` installer. It installs the global Localbox skill without host \`npx\`, \`npm\`, or a package fetch, then registers HostDaemon and the six-hour updater with launchd. Verify with \`localbox status\`, \`localbox skill status --json\`, and \`localbox help --json\`.

## Use

- \`localbox vm start\`, \`localbox vm stop\`, and \`localbox status\` manage the local computer.
- \`localbox shell exec -- <command>\` runs bounded commands in the guest.
- \`localbox login\` authenticates remote relay use; it is independent of MCP.
- \`localbox mcp install --json\` prints optional MCP configuration.
- [Localbox skill](${links.skill}) is the agent-facing workflow and recovery guide.

## What it provides

${bullets(asks)}

## Principles

- CLI and MCP expose the same catalog, schemas and behavior.
- The VM is the execution boundary; the host daemon owns lifecycle and the persistent disk.
- Remote relay traffic is authenticated, bounded and outbound from the host.
- Releases and managed skill updates verify signatures and checksums before replacement.
- Existing unmanaged skills and project-local skills are left alone.

## Links

- [Repository](${links.repo})
- [Latest release](${links.releases})
- [Installation reference](${links.installation})
- [Optional MCP reference](${links.mcp})
`;
}
