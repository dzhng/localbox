# Agent Computer product map

> This is the decision record from the exploration walk. The durable rationale
> for the shipped implementation is in [README.md](README.md).

This map records the decisions from the exploration walk before implementation.

## Known knowns

- A Mac app runs a durable, preconfigured Linux VM with a virtual desktop.
- Cloud and local AI agents can use the VM through either the CLI or optional
  MCP.
- VM outbound traffic uses the Mac's network and residential egress.
- A hosted outbound relay avoids inbound firewall configuration, port
  forwarding, and Tailscale.
- Shell is the authority. Other tools are convenience interfaces.
- OAuth authorizes access; VM selection should be part of consent where MCP
  client behavior permits it.
- The VM is the sole security boundary.
- Apple silicon macOS is the first host target.

## Decision ledger

| Decision | Answer | Closed by |
| --- | --- | --- |
| Product promise | Personal agent computer with virtual desktop | User |
| Agent connection | Outbound-only hosted relay | User |
| VM lifetime | Durable VM with explicit reset/reprovision | User |
| API shape | Layered API with unrestricted shell authority | User |
| Security model | One VM trust boundary; no per-tool isolation | User |
| Authorization | MCP OAuth, ideally selecting a VM | User |
| Protocol | Standards-first Streamable HTTP MCP with OAuth | User |
| CLI/MCP relationship | Identical catalog, schemas, behavior, errors, permissions | User |
| Distribution | CLI plus consumer skill | User |
| VM count | One by default; multiple if low effort | Agent on behalf of user |

## Unknown knowns

- Setup should be agent-driven and close to zero effort.
- The CLI must work without MCP.
- The skill is an executable runbook covering installation, MCP setup, usage,
  and recovery.
- The app owns VM lifecycle; the CLI reports and controls it.
- Files, packages, cookies, browser profile, and desktop state persist.
- Reset is explicit and destructive.
- The Mac user needs visible status, pause/stop, reset, and recovery controls.

## Unknown unknowns

1. Local Apple silicon virtualization, Linux boot, persistence, networking,
   display, and suspend/resume need a spike.
2. Desktop startup time and resource use need measurement on a Mac.
3. Shared browser state needs deterministic target ownership and persistence
   semantics.
4. The hosted relay is a separate trust boundary and needs explicit channel,
   revocation, and logging rules.
5. CLI/MCP drift must be prevented by one operation catalog and one handler
   owner.
6. VPNs, Private Relay, corporate networks, ISP filtering, sleep, and network
   changes can affect residential egress and relay connectivity.
7. Release signing, notarization, checksums, and auto-update policy need a
   decision before public distribution.
8. Rate, bandwidth, disk, execution-time, and relay-cost limits remain needed
   even though per-tool security scopes do not.

## First implementation spikes

- Boot and control a minimal Linux VM through the intended macOS virtualization
  stack.
- Build the desktop image with loopback-only VNC and a headful browser.
- Prove the VM's observed outbound IP and reconnect behavior across sleep/wake.
- Exercise the shared operation catalog through CLI and MCP adapters.
- Validate OAuth resource selection; fall back to one VM per account if client
  constraints make VM selection impractical.
