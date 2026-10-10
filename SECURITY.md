# Security model

## The VM is the boundary

The Linux VM is the product's security boundary. The agent, its tools, and
everything it installs inside the VM share one trust domain and one filesystem.
Shell is the authority; browser, filesystem, screenshot, and computer-use
operations are convenience adapters over that same authority.

Do not create per-tool capability splitting, payload allowlists, or approval
prompts for actions that an authorized agent can already cause through shell.
Those layers would add complexity without creating a meaningful boundary inside
the VM.

Authorization grants access to the VM as a whole. The CLI and MCP must enforce
the same authorization decision and the same operation permissions.

## The host remains outside the VM boundary

The VM must not silently gain access to the Mac host's filesystem, processes,
credentials, or UI. Host integration is an explicit product feature and must be
implemented through a narrow, reviewed interface. The initial product only
needs the VM's own filesystem, processes, desktop, and outbound network.

## Relay boundary

The hosted relay is a transport boundary between an agent and the local app. It
must authenticate channels, support revocation, rotate connection credentials,
and avoid logging secrets or capability-bearing URLs. The relay may observe
transport metadata and request/response traffic in the initial design; the spec
must make that trust explicit before adding end-to-end encryption.

## Non-security limits

Uniform rate, bandwidth, disk, execution-time, and relay-cost limits are valid
sanity and operations controls. They apply to every authorized caller and do not
split the VM's trust domain.
