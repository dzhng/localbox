# Slice 02 — Guest gateway and host boundary

## Contract unlocked

The host can invoke bounded shell and filesystem operations inside the real VM
through one authenticated guest channel.

## API seam and ownership

`apps/guest-gateway` owns guest process groups, filesystem paths, output caps,
timeouts, cancellation, structured logs, and the guest-side mutation journal.
`apps/macos` owns the host-side VM adapter and user-only local control socket.
Prefer a virtio socket or equivalent private guest channel; no public guest
listener is introduced.

Initial real handlers: `system.info`, `shell.exec`, `fs.list`, `fs.stat`,
`fs.read`, `fs.write`, `fs.mkdir`, and `fs.remove`.

## Runnable artifact

`agent-computer exec run -- printf hello` executes in the guest, and a second
invocation after VM restart reads a persisted marker.

## Verification

- Process trees are killed on timeout/cancel, including shell children.
- Stdout/stderr and execution time are bounded before buffering.
- Guest paths cannot escape the VM filesystem or reach host paths.
- Duplicate mutation IDs return the original result instead of executing twice.
- A dropped response returns an explicit uncertain state; the client never
  blindly resubmits a write.

## Human review

Review the host/guest boundary and the command/output contract. No visual gate.
