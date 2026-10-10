# Guest agent

The Linux image runs `apps/guest-agent/src/index.ts` as its guest service. The
process reads and writes the length-prefixed JSON protocol on standard streams;
the production image connects those streams to a virtio-serial channel. A
standard-stream entrypoint keeps the same service probeable without booting a
VM.

Configuration comes from environment variables:

- `AGENT_COMPUTER_ROOT` — guest filesystem root (defaults to `/`).
- `AGENT_COMPUTER_VM_ID` — VM identity (defaults to `vm_01`).
- `AGENT_COMPUTER_CHANNEL_EPOCH` — host-issued channel epoch (defaults to `1`).
- `AGENT_COMPUTER_READINESS_MARKER` — marker written before the `ready` frame.
- `AGENT_COMPUTER_INVENTORY` — comma-separated inventory names. The default is
  the Duet-compatible inventory contract.

The first output frame is `ready`, containing the VM ID, channel epoch,
inventory digest, and readiness marker. Requests with a stale epoch or VM ID
are rejected. Work is bounded by the gateway's shell/filesystem limits and the
service's pending-request and input-buffer limits. `cancel` frames abort the
matching request through its `AbortSignal`.

For a local protocol smoke test after building:

```sh
printf '' | AGENT_COMPUTER_ROOT="$PWD" AGENT_COMPUTER_READINESS_MARKER="$PWD/.agent-computer-ready" \
  npx tsx apps/guest-agent/src/index.ts
```
