# 20 hole-punch and transfer spike (go/no-go)

**Unlocks:** Q4, Q5 and L6 as a transport: two Macs find each other through
Cloudflare's public STUN server, connect over UDP (local network first, then hole
punching), and move an 8 GiB sparse disk with chunking, resume and authentication.
Confirm item 6.

## Seam

- New executable target `localbox-punchlab` in `apps/macos/HostDaemon/Package.swift`,
  Network.framework UDP only. Commands: `punchlab offer` prints a JSON candidate
  set (local addresses plus the STUN-reflected address and port from
  `stun.cloudflare.com:3478`) and a one-time key; `punchlab answer <offer.json>`
  replies; both sides then punch, preferring local candidates.
- Transfer: fixed-size chunks with sha256 per chunk, a resume bitmap persisted
  beside the temp file, AEAD with the one-time key (CryptoKit ChaChaPoly), sparse
  holes sent as "zero chunk" markers.
- Candidate exchange is a pasted file; no Convex in this spike.
- Probe `20-punch-spike.ts`, tiers `s`, `l`, `x`.

## See it

- `npm run proof -- 20 --tier s,l`: two punchlab processes on this Mac over
  loopback and the LAN address: an 8 GiB sparse file transfers, the receiver is
  killed at ~40%, restarted, resumes from the bitmap, sha256 matches; a tampered
  chunk is rejected; throughput against an `iperf3` baseline on the same path.
- `npm run proof -- 20 --tier x`: the same between this Mac and a second Mac on
  another network. Exits 2 (`blocked: no second Mac on another network`) until the
  user runs it; report whether the punch succeeded and, if not, the NAT type each
  side's STUN responses suggest.

## Gates

Tier `s,l`: resume, integrity, tamper rejection, LAN throughput ≥ 70% of `iperf3`.
Tier `x` is advisory (P13).

## Stop rule

Resume, integrity or throughput failing reopens the transport choice (QUIC with a
pre-shared key instead of custom framing): record and reslice 37. A failed punch
alone is accepted; Q5 says the copy fails with why.

## Delegated

Chunk size, congestion and pacing, STUN retry budget, the "zero chunk" encoding.

## Feedback that would change it

The user wanting a fallback after seeing tier `x` fail (that is a new decision,
not a fix here).
