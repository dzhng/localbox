# 37 Transfer library

**Unlocks:** slice 20's proven transport as a library with no daemon dependency.

## Seam

New SwiftPM target `ImageTransfer` in `apps/macos/HostDaemon/Package.swift`; it
never imports `HostDaemonCore`.

- `TransferManifest { files: [{ path, size, chunkSize, chunkHashes, zeroChunks }] }`
  covering an image directory (disk and boot store).
- `ResumeBitmap`, persisted beside the receiver's temp directory.
- AEAD with the one-time per-copy key (CryptoKit ChaChaPoly), nonce per chunk.
- `protocol Transport` with `LANTransport` (local candidates) and
  `PunchedUDPTransport` (STUN via `stun.cloudflare.com:3478`, then hole punching).
- `PathSelector`: try local candidates, then punched; report which path won, or
  every path tried and why each failed (for `copy_unreachable`).
- `Sender.send(directory, manifest, transport)` and `Receiver.receive(into: temp,
  transport) -> TransferReport { bytes, duration, path }`.
- `localbox-punchlab` from slice 20 is rewritten on top of this target and kept as
  the manual tool.

## See it

`swift test --filter ImageTransferTests`.

## Gates

Tier `s`, `ImageTransferTests` over an in-memory and a loopback transport: injected
loss and reordering, a receiver killed and resumed, a tampered chunk refused, a
wrong key refused, holes preserved (received sparse file's allocated bytes ≈
source's).

## Delegated

Chunk size; congestion and pacing; internal threading.

## Stays green

Slice 20's probe at tier `s,l` re-run through the library.
