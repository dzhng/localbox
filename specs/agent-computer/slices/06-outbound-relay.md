# Slice 06 — Outbound relay

## Contract unlocked

The Mac can serve authorized remote operations through an outbound-only channel.

## API seam and ownership

`apps/macos` owns a TLS channel supervisor and `apps/relay` owns account/channel
admission, frame routing, revocation, and bounded transport logs. Frames preserve
`vm_id`, `request_id`, `mutation_id`, deadlines, and sequence/epoch. The relay
does not own business handlers and only queues/replays safe observations.

## Runnable artifact

`agent-computer relay probe` starts a fake relay and local daemon, then runs a
remote `system.info` and `shell.exec` call without opening an inbound port.

## Verification

- NAT-only outbound connection, heartbeat, bounded backoff, and reconnect work.
- Stale channel epochs and revoked channel grants are rejected.
- Frame size, queue, rate, and deadline limits fail explicitly.
- Lost mutation responses never cause duplicate execution.
- Logs redact bearer tokens, capability URLs, cookies, and command secrets.
- Payload visibility to the relay is documented as an intentional v1 trust.
