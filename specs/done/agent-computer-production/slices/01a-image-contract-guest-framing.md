# Slice 01a — Image contract, Duet inventory, and guest framing

## Contract unlocked

The later image builder and native host daemon have a versioned, reproducible image identity and a bounded guest-channel wire format before any real Linux artifact is published.

## Seam

`packages/vm-image` owns the canonical manifest digest, artifact digests, readiness marker, display/loopback requirements, and machine-readable Duet-compatible inventory. `packages/guest-gateway/src/protocol.ts` owns length-prefixed JSON guest frames for request, response, ready, and cancel messages. The inventory is a compatibility target; it is not the operation catalog.

## Human runnable artifact

The test suite verifies canonical digest stability across object-key order, rejects x86-only inventory entries, checks readiness/inventory metadata, and round-trips partial guest frames.

## Verification

- `npm run build && npm test`.
- Inventory names cover every Duet required binary and Python module; actual versions/checksums are filled by slice 01b's builder.
- Frame lengths are bounded, partial buffers are retained, and malformed frames fail closed.

## Delegated choices

Internal TypeScript names may change while the manifest fields and frame kinds remain stable. This slice deliberately does not claim that a Linux image or real guest exists; that is slice 01b.
