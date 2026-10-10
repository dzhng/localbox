# Slice 04 — Network and egress diagnostics

## Contract unlocked

The product reports where guest traffic exits and what happens when the Mac's
network changes; it does not make an unprovable anti-bot promise.

## API seam and ownership

`network.egress` runs a controlled HTTPS/DNS echo from inside the guest and
returns observed address family, public IP, resolver, interface, timestamp, and
confidence. The host daemon reports relay/host comparison; neither layer stores
third-party credentials or arbitrary request headers.

## Runnable artifact

`agent-computer network egress --json --endpoint <controlled-echo>` prints a
structured report from guest and host. A fixture can force DNS, IPv6, and
network-interface failures.

## Verification

- Guest traffic uses the Mac's current network under ordinary NAT.
- VPN, Private Relay, corporate NAT, IPv6-only, captive-portal, and DNS failures
  are reported as facts with actionable diagnostics.
- A network change reconnects the relay or reports disconnected state.
- Product copy says “runs from this Mac’s network”; it never says every site will
  accept the traffic.

## Human review

Review the diagnostic wording and the boundary between evidence and promise.
